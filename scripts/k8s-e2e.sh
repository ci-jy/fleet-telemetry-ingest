#!/usr/bin/env bash
# Kubernetes chaos suite: creates a k3d cluster, imports the locally built image, installs the
# Helm chart with values-ci.yaml and runs the in-cluster e2e Job (pod kill, scale 1->3->2, broker
# restart, database restart). Writes reports/k8s-chaos.json and exits non-zero unless every
# simulated message was stored exactly once and Prometheus scraped every ingest pod.
#
#   scripts/k8s-e2e.sh [--quick] [--keep] [--reuse]
#     --quick   smaller run (fewer pod kills); the default is the full run
#     --keep    leave the cluster running afterwards (K8S_E2E_KEEP=1 does the same)
#     --reuse   use an existing cluster of the same name instead of failing
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
CLUSTER=${K8S_E2E_CLUSTER:-fleet-e2e}
NAMESPACE=${K8S_E2E_NAMESPACE:-fleet}
RELEASE=t
IMAGE=fleet-telemetry-ingest:k8s
API_PORT=${K8S_E2E_API_PORT:-26443}
REPORT=${K8S_E2E_REPORT:-reports/k8s-chaos.json}
KEEP=${K8S_E2E_KEEP:-0}
REUSE=0
QUICK=0
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    --keep) KEEP=1 ;;
    --reuse) REUSE=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [[ $QUICK == 1 ]]; then
  E2E_SET="e2e.devices=200,e2e.tripsPerDevice=1,e2e.podKills=3,e2e.rate=1500"
else
  E2E_SET="e2e.devices=200,e2e.tripsPerDevice=2,e2e.podKills=6,e2e.rate=1500"
fi

log() { printf '\n[k8s-e2e %s] %s\n' "$(date +%H:%M:%S)" "$*"; }

# Docker and k3d talk to the Docker daemon; fall back to sudo -n if this user cannot reach it.
if docker info >/dev/null 2>&1; then SUDO=(); else SUDO=(sudo -n); fi
DOCKER=("${SUDO[@]}" docker)
K3D=("${SUDO[@]}" k3d)
for tool in docker k3d kubectl helm; do
  command -v "$tool" >/dev/null || { echo "missing tool: $tool" >&2; exit 2; }
done

WORK=$(mktemp -d)
export KUBECONFIG="$WORK/kubeconfig"
KUBECTL=(kubectl -n "$NAMESPACE")
K3S_IMAGE=rancher/k3s:v1.31.5-k3s1
K3S_EXTRA=()
HELM_EXTRA=()
HOST_DOCKER=("${DOCKER[@]}")
PRIVATE_DOCKERD=""
PRIVATE_EXEC=""

# Nested hosts (a Kubernetes node or system container running Docker) may refuse containers with
# their own network namespace: runc cannot write the sysctls Docker sets for them. In that case
# run a private dockerd for the cluster only: its own socket and data directory, the crun runtime
# (which can write those sysctls), and no iptables changes on the host. Without NAT the node has
# no internet access, so k3s loads its system images from the airgap bundle and every workload
# image is imported. The kubelet and kube-proxy get the settings k3s needs inside a container
# without /dev/kmsg, conntrack sysctls or br_netfilter.
start_private_dockerd() {
  command -v crun >/dev/null || { echo "nested host detected but crun is not installed (apt-get install crun)" >&2; exit 2; }
  PRIVATE_DOCKERD=$(mktemp -d "${TMPDIR:-/tmp}/fleet-k3d-dockerd.XXXXXX")
  # Unix socket paths are limited to 108 bytes, so sockets live under a short path; data stays on disk.
  PRIVATE_EXEC=/run/fleet-k3d-${PRIVATE_DOCKERD##*.}
  sudo -n mkdir -p "$PRIVATE_EXEC"
  local sock="unix://$PRIVATE_EXEC/docker.sock"
  log "default Docker runtime cannot start containers here; starting a private dockerd (crun) on $sock"
  sudo -n bash -c "nohup dockerd --data-root '$PRIVATE_DOCKERD/data' --exec-root '$PRIVATE_EXEC/exec' \
    --pidfile '$PRIVATE_DOCKERD/dockerd.pid' -H '$sock' \
    --add-runtime crun=$(command -v crun) --default-runtime crun \
    --iptables=false --ip6tables=false --ip-masq=false --bridge=none \
    --host-gateway-ip 10.255.255.254 --exec-opt native.cgroupdriver=cgroupfs \
    --feature containerd-snapshotter=false \
    > '$PRIVATE_DOCKERD/dockerd.log' 2>&1 &"
  DOCKER=(sudo -n docker -H "$sock")
  K3D=(sudo -n env "DOCKER_HOST=$sock" "DOCKER_SOCK=$PRIVATE_EXEC/docker.sock" k3d)
  for _ in $(seq 1 60); do "${DOCKER[@]}" info >/dev/null 2>&1 && break; sleep 0.5; done
  "${DOCKER[@]}" info >/dev/null 2>&1 || { cat "$PRIVATE_DOCKERD/dockerd.log" >&2; exit 1; }
  local airgap="$ROOT/.cache/k3s-airgap"
  if [[ ! -s "$airgap/k3s-airgap-images-amd64.tar.zst" ]]; then
    log "downloading the k3s airgap image bundle"
    mkdir -p "$airgap"
    curl -fsSL -o "$airgap/k3s-airgap-images-amd64.tar.zst.part" \
      "https://github.com/k3s-io/k3s/releases/download/v1.31.5%2Bk3s1/k3s-airgap-images-amd64.tar.zst"
    mv "$airgap/k3s-airgap-images-amd64.tar.zst.part" "$airgap/k3s-airgap-images-amd64.tar.zst"
  fi
  K3S_EXTRA=(
    -v "$airgap:/var/lib/rancher/k3s/agent/images@server:0"
    --k3s-arg "--kubelet-arg=feature-gates=KubeletInUserNamespace=true@server:0"
    --k3s-arg "--kube-proxy-arg=conntrack-max-per-core=0@server:0"
    --k3s-arg "--kube-proxy-arg=masquerade-all=true@server:0"
    # overlayfs inside the nested node breaks memory protection of some mapped libraries.
    --k3s-arg "--snapshotter=native@server:0"
  )
  # The host's AppArmor profile for /usr/sbin/mosquitto attaches by path inside the nested node too
  # and denies the broker its config file; run a copy of the binary from another path.
  HELM_EXTRA=(--set-json 'mosquitto.command=["sh","-c","cp /usr/sbin/mosquitto /tmp/mosquitto-broker && exec /tmp/mosquitto-broker -c /mosquitto/config/mosquitto.conf"]')
  # Reuse images the host daemon already has instead of pulling them again.
  for img in "$K3S_IMAGE" ghcr.io/k3d-io/k3d-tools:5.8.3 ghcr.io/k3d-io/k3d-proxy:5.8.3; do
    if "${HOST_DOCKER[@]}" image inspect "$img" >/dev/null 2>&1; then
      "${HOST_DOCKER[@]}" save "$img" | "${DOCKER[@]}" load -q >/dev/null
    fi
  done
}

stop_private_dockerd() {
  [[ -n $PRIVATE_DOCKERD ]] || return 0
  if [[ -f "$PRIVATE_DOCKERD/dockerd.pid" ]]; then
    local pid
    pid=$(cat "$PRIVATE_DOCKERD/dockerd.pid")
    sudo -n kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 60); do sudo -n kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
  fi
  # Bind mounts of a daemon that died uncleanly would keep the directory busy.
  for d in "$PRIVATE_DOCKERD" "$PRIVATE_EXEC"; do
    awk -v d="$d/" 'index($2, d) == 1 {print $2}' /proc/mounts | sort -r | xargs -r sudo -n umount 2>/dev/null || true
    sudo -n rm -rf "$d" || true
  done
}

cleanup() {
  local code=$?
  if [[ $code != 0 ]] && [[ -s "$KUBECONFIG" ]]; then
    mkdir -p reports/k8s-logs
    "${KUBECTL[@]}" get pods -o wide > reports/k8s-logs/pods.txt 2>&1 || true
    for p in $("${KUBECTL[@]}" get pods -o name 2>/dev/null); do
      "${KUBECTL[@]}" logs "$p" --all-containers --tail 400 > "reports/k8s-logs/${p#pod/}.log" 2>&1 || true
    done
    log "failed (exit $code); pod logs in reports/k8s-logs/"
  fi
  if [[ $KEEP != 1 ]]; then
    log "deleting cluster $CLUSTER"
    "${K3D[@]}" cluster delete "$CLUSTER" >/dev/null 2>&1 || true
    stop_private_dockerd
  else
    log "cluster kept: export KUBECONFIG=\$(k3d kubeconfig write $CLUSTER)"
  fi
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT

started=$(date +%s)
"${DOCKER[@]}" image inspect "$K3S_IMAGE" >/dev/null 2>&1 || "${DOCKER[@]}" pull -q "$K3S_IMAGE" >/dev/null
if ! "${DOCKER[@]}" run --rm --entrypoint /bin/sh "$K3S_IMAGE" -c true >/dev/null 2>&1; then
  start_private_dockerd
fi
if "${K3D[@]}" cluster list "$CLUSTER" >/dev/null 2>&1; then
  if [[ $REUSE != 1 ]]; then
    log "cluster $CLUSTER exists; deleting it (use --reuse to keep it)"
    "${K3D[@]}" cluster delete "$CLUSTER"
  fi
fi
if ! "${K3D[@]}" cluster list "$CLUSTER" >/dev/null 2>&1; then
  log "creating k3d cluster $CLUSTER (API on 127.0.0.1:$API_PORT)"
  if ! "${K3D[@]}" cluster create "$CLUSTER" --servers 1 --agents 0 --no-lb --servers-memory "${K8S_E2E_NODE_MEMORY:-3g}" --image "$K3S_IMAGE" "${K3S_EXTRA[@]}" \
    --api-port "127.0.0.1:$API_PORT" \
    --k3s-arg "--disable=traefik@server:0" \
    --wait --timeout 180s; then
    echo "k3d could not create the cluster. k3d needs Docker to run privileged containers with their" >&2
    echo "own network namespace (not possible inside some nested or sandboxed hosts)." >&2
    exit 1
  fi
fi
"${K3D[@]}" kubeconfig get "$CLUSTER" > "$KUBECONFIG"

log "building $IMAGE"
# Host networking for RUN steps: on nested hosts the builder cannot create network namespaces either.
"${HOST_DOCKER[@]}" build --network host -q -t "$IMAGE" . >/dev/null
if [[ -n $PRIVATE_DOCKERD ]]; then "${HOST_DOCKER[@]}" save "$IMAGE" | "${DOCKER[@]}" load -q >/dev/null; fi
images=("$IMAGE")
# Pre-load the third-party images when they are available locally (saves pulls inside the node).
for img in postgres:16-alpine eclipse-mosquitto:2 prom/prometheus:v2.55.1; do
  if [[ -n $PRIVATE_DOCKERD ]] && "${HOST_DOCKER[@]}" image inspect "$img" >/dev/null 2>&1; then
    "${HOST_DOCKER[@]}" save "$img" | "${DOCKER[@]}" load -q >/dev/null
  fi
  if "${DOCKER[@]}" image inspect "$img" >/dev/null 2>&1 || "${DOCKER[@]}" pull -q "$img" >/dev/null 2>&1; then images+=("$img"); fi
done
log "importing images: ${images[*]}"
"${K3D[@]}" image import --mode direct -c "$CLUSTER" "${images[@]}" >/dev/null

log "installing chart (values-ci.yaml)"
kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
helm upgrade --install "$RELEASE" charts/telemetry -n "$NAMESPACE" -f charts/telemetry/values-ci.yaml \
  "${HELM_EXTRA[@]}" --wait --timeout 6m
"${KUBECTL[@]}" get pods -o wide

log "starting the e2e runner Job ($E2E_SET)"
"${KUBECTL[@]}" delete job "$RELEASE-e2e" --ignore-not-found >/dev/null
helm template "$RELEASE" charts/telemetry -n "$NAMESPACE" -f charts/telemetry/values-ci.yaml \
  --set "e2e.enabled=true,$E2E_SET" --show-only templates/e2e-job.yaml | "${KUBECTL[@]}" apply -f - >/dev/null

# Wait for the runner pod, then follow its log until the Job finishes.
for _ in $(seq 1 120); do
  phase=$("${KUBECTL[@]}" get pods -l "app.kubernetes.io/component=e2e" -o jsonpath='{.items[0].status.phase}' 2>/dev/null || true)
  [[ $phase == Running || $phase == Succeeded || $phase == Failed ]] && break
  sleep 2
done
"${KUBECTL[@]}" logs -f "job/$RELEASE-e2e" > "$WORK/runner.log" 2>&1 &
follower=$!
status=""
deadline=$(( $(date +%s) + 2400 ))
while [[ $(date +%s) -lt $deadline ]]; do
  succeeded=$("${KUBECTL[@]}" get job "$RELEASE-e2e" -o jsonpath='{.status.succeeded}' 2>/dev/null || true)
  failed=$("${KUBECTL[@]}" get job "$RELEASE-e2e" -o jsonpath='{.status.failed}' 2>/dev/null || true)
  if [[ ${succeeded:-0} -ge 1 ]]; then status=succeeded; break; fi
  if [[ ${failed:-0} -ge 1 ]]; then status=failed; break; fi
  sleep 3
done
sleep 1
kill "$follower" 2>/dev/null || true
"${KUBECTL[@]}" logs "job/$RELEASE-e2e" > "$WORK/runner.log" 2>&1 || true
grep -v '^K8S_CHAOS_REPORT ' "$WORK/runner.log" | grep -E '"msg":"scenario (start|done|failed)"' | cut -c1-400 || true

line=$(grep '^K8S_CHAOS_REPORT ' "$WORK/runner.log" | tail -1 || true)
if [[ -z $line ]]; then
  tail -50 "$WORK/runner.log"
  echo "runner produced no report (job $status)" >&2
  exit 1
fi
mkdir -p "$(dirname "$REPORT")"
node -e '
  const r = JSON.parse(process.argv[1]);
  r.mode = process.argv[2];
  r.wallClockS = Number(process.argv[3]);
  require("fs").writeFileSync(process.argv[4], JSON.stringify(r, null, 2) + "\n");
  console.log("\nscenario            sent    stored  lost  dup  recovery");
  for (const s of r.scenarios) console.log(
    `${s.scenario.padEnd(18)} ${String(s.sent ?? "-").padStart(6)} ${String(s.stored ?? "-").padStart(9)} ${String(s.lost ?? "-").padStart(5)} ${String(s.duplicated ?? "-").padStart(4)}  ${s.recoveryMs == null ? "-" : (s.recoveryMs / 1000).toFixed(1) + " s"}${s.ok ? "" : "  FAILED " + (s.errors || []).join("; ")}`);
  if (r.prometheus) console.log(`prometheus: ${r.prometheus.targetsUp}/${r.prometheus.ingestPods} ingest pods scraped, alert rules: ${(r.prometheus.alertRules || []).length}`);
' "${line#K8S_CHAOS_REPORT }" "$([[ $QUICK == 1 ]] && echo quick || echo full)" "$(( $(date +%s) - started ))" "$REPORT"

# Keep the README results block and the figure in step with the report just written.
if [[ $REPORT == reports/k8s-chaos.json ]]; then python3 scripts/sync-results.py || log "could not sync README results"; fi

ok=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).ok)' "$REPORT")
if [[ $status != succeeded || $ok != true ]]; then
  log "FAILED: job $status, report ok=$ok ($REPORT)"
  exit 1
fi
log "passed: every simulated message stored exactly once ($REPORT)"
