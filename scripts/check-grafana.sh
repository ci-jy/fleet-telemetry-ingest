#!/usr/bin/env bash
# Loads the Grafana dashboard into a real Grafana: renders the chart with grafana.enabled=true,
# extracts the provisioning and dashboard ConfigMaps exactly as the pod would mount them, starts
# the same Grafana image in Docker with those files, and checks through the HTTP API that the
# Prometheus datasource and the fleet-ingest dashboard with all its panels were provisioned.
#
#   scripts/check-grafana.sh        (GRAFANA_CHECK_PORT, default 23000)
set -euo pipefail

cd "$(dirname "$0")/.."
PORT=${GRAFANA_CHECK_PORT:-23000}
NAME=fleet-grafana-check-$$
if docker info >/dev/null 2>&1; then DOCKER=(docker); else DOCKER=(sudo -n docker); fi

WORK=$(mktemp -d)
cleanup() {
  "${DOCKER[@]}" rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

helm template t charts/telemetry -f charts/telemetry/values-ci.yaml --set grafana.enabled=true \
  --show-only templates/grafana.yaml > "$WORK/grafana.yaml"
IMAGE=$(python3 - "$WORK" <<'EOF'
import os, sys, yaml
work = sys.argv[1]
docs = [d for d in yaml.safe_load_all(open(os.path.join(work, "grafana.yaml"))) if d]
for d in docs:
    if d["kind"] != "ConfigMap":
        continue
    name = d["metadata"]["name"]
    sub = "dashboards" if name.endswith("-dashboards") else "provisioning"
    os.makedirs(os.path.join(work, sub), exist_ok=True)
    for key, value in d["data"].items():
        with open(os.path.join(work, sub, key), "w") as f:
            f.write(value)
deploy = next(d for d in docs if d["kind"] == "Deployment")
print(deploy["spec"]["template"]["spec"]["containers"][0]["image"])
EOF
)
chmod -R a+rX "$WORK"

echo "[grafana-check] starting $IMAGE on 127.0.0.1:$PORT"
"${DOCKER[@]}" run -d --name "$NAME" --network host --memory 256m \
  -e GF_SERVER_HTTP_ADDR=127.0.0.1 -e GF_SERVER_HTTP_PORT="$PORT" \
  -e GF_AUTH_ANONYMOUS_ENABLED=true -e GF_AUTH_ANONYMOUS_ORG_ROLE=Viewer \
  -e GF_ANALYTICS_REPORTING_ENABLED=false -e GF_ANALYTICS_CHECK_FOR_UPDATES=false \
  -v "$WORK/provisioning/datasources.yaml:/etc/grafana/provisioning/datasources/datasources.yaml:ro" \
  -v "$WORK/provisioning/dashboards.yaml:/etc/grafana/provisioning/dashboards/dashboards.yaml:ro" \
  -v "$WORK/dashboards:/var/lib/grafana/dashboards:ro" \
  "$IMAGE" >/dev/null

URL=http://127.0.0.1:$PORT
for _ in $(seq 1 90); do
  curl -fsS "$URL/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "$URL/api/health" >/dev/null || { "${DOCKER[@]}" logs "$NAME" | tail -40; echo "Grafana did not start" >&2; exit 1; }

# Dashboard provisioning runs right after startup; give it a few seconds.
for _ in $(seq 1 30); do
  curl -fsS "$URL/api/dashboards/uid/fleet-ingest" > "$WORK/dashboard.out" 2>/dev/null && break
  sleep 1
done
curl -fsS "$URL/api/datasources/uid/prometheus" > "$WORK/datasource.out" || {
  echo "Prometheus datasource was not provisioned" >&2; exit 1; }

python3 - "$WORK" <<'EOF'
import json, os, sys
work = sys.argv[1]
expected = json.load(open(os.path.join(work, "dashboards", "fleet-ingest.json")))
try:
    loaded = json.load(open(os.path.join(work, "dashboard.out")))
except (OSError, ValueError):
    sys.exit("dashboard fleet-ingest was not provisioned")
ds = json.load(open(os.path.join(work, "datasource.out")))
dash = loaded["dashboard"]
panels = [p for p in dash.get("panels", []) if p.get("type") != "row"]
want = [p for p in expected.get("panels", []) if p.get("type") != "row"]
assert dash["uid"] == "fleet-ingest", dash["uid"]
assert loaded["meta"].get("provisioned") is True, "dashboard not marked as provisioned"
assert len(panels) == len(want), f"{len(panels)} panels loaded, {len(want)} expected"
assert ds["type"] == "prometheus", ds["type"]
print(f"[grafana-check] OK: dashboard '{dash['title']}' loaded with {len(panels)} panels; "
      f"datasource '{ds['name']}' ({ds['url']})")
EOF
