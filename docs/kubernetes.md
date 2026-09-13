# Running on Kubernetes

The Helm chart in `charts/telemetry` runs the ingest StatefulSet, PostgreSQL, Mosquitto, Prometheus, an optional Grafana, a CPU HorizontalPodAutoscaler and an in-cluster chaos Job. The chart sets `PARTITIONS=16`, which switches the service into partitioned mode (see design.md).

## By hand on k3d

```bash
docker build -t fleet-telemetry-ingest:k8s .
k3d cluster create fleet --no-lb --api-port 127.0.0.1:26443 --k3s-arg "--disable=traefik@server:0"
k3d image import -c fleet fleet-telemetry-ingest:k8s
helm upgrade --install t charts/telemetry -n fleet --create-namespace --wait   # values.yaml: HPA on
kubectl -n fleet port-forward svc/t-prometheus 29090:9090
```

`values-ci.yaml` holds requests and limits that fit a 6 GB machine: 3 ingest pods at 256 MiB, Postgres 384 MiB, Prometheus 256 MiB, no Grafana and no HPA. The autoscaler is off there because the chaos suite scales the StatefulSet by hand and an autoscaler would undo that. Set `grafana.enabled=true` to run a provisioned Grafana pod.

## Chaos suite

`scripts/k8s-e2e.sh [--quick] [--keep]` creates the cluster, builds and imports the image, installs the chart with `values-ci.yaml` and runs the e2e Job (`scripts/k8s-runner.ts`). For each scenario the Job publishes a fresh 200-vehicle fleet, with the simulator's drops, duplicates, reordering and late messages, at 1500 messages/s, and starts the fault 20% of the way through.

| Scenario | Fault (through the Kubernetes API) |
| --- | --- |
| `pod-kill` | a different ingest pod deleted with grace period 0 every 4 s (3 kills with `--quick`, 6 in the full run) |
| `scale` | StatefulSet scaled 3, 1, 3, 2, each step waiting until every partition is owned |
| `mosquitto-restart` | broker pod deleted, restarted from its persistence volume |
| `postgres-restart` | database pod deleted, restarted from its volume |

After each scenario the Job checks that every delivered `(device, seq)` is stored, none twice, nothing extra, and no trip twice. It records the recovery time (from the last fault action until every partition is owned and a new row has committed) and checks that Prometheus scrapes every ingest pod and has the alert rules loaded. The script writes `reports/k8s-chaos.json`, exits non-zero on any loss, duplicate or unscraped pod, and runs `scripts/sync-results.py` to refresh the results block in the README and redraw `docs/chaos-recovery.png`, which plots recovery time per fault for this suite and the Docker one.

`.github/workflows/k8s.yml` runs helm lint, kubeconform, promtool and then the same script, and uploads the report.

## Nested container hosts

On a host that is itself a container, Docker's runc can't start containers with their own network namespace. The script detects this and runs the cluster on a private dockerd (crun, no iptables changes, k3s images from the airgap bundle). Such a host's AppArmor profile for `/usr/sbin/mosquitto` also blocks the broker's config file, so the script runs a copy of the binary through `mosquitto.command`. The committed results come from that setup. On standard Docker hosts, like GitHub's `ubuntu-latest` runners, none of this is used.
