# Tests

```bash
npm test
```

The suite runs in process: PGlite for Postgres and an in-process Aedes MQTT broker on a port between 20000 and 29999. No Docker needed.

| File | What it checks |
| --- | --- |
| `test/tripStateMachine.test.ts` | Every row of the transition table, idle thresholds, gaps, anchoring, replay determinism, delivery through the reorder buffer |
| `test/reorderBuffer.test.ts` | Release rules, late vs. duplicate classification, cloning |
| `test/geo.test.ts` | Haversine against known distances, antimeridian, polyline sums |
| `test/telemetry.test.ts` | Schema validation and topic matching |
| `test/ingestor.test.ts` | Storage, dedup within and across batches and restarts, late flags, rollback and retry, recovery by replay, stale sweep |
| `test/resilience.test.ts` | Acknowledge after commit, unknown commit outcome, buffer recovery across repeated crashes, graceful shutdown, queue bound, MQTT redelivery |
| `test/invariants.test.ts` | The fault-injection invariant checker |
| `test/fleetReplay.integration.test.ts` | Seeded 12-vehicle fleets with faults; trip count must match ground truth and every distance must be within 1% |
| `test/mqttFleet.integration.test.ts` | The same for a 15-vehicle fleet through a real MQTT broker, plus rejection of malformed messages |
| `test/api.test.ts` | All REST endpoints |
| `test/partition.test.ts` | FNV-1a vectors, partition spread, wrong-partition rejection |
| `test/leases.test.ts` | Lease acquisition, renewal, expiry, takeover, fencing, reclaim by a restarted pod |
| `test/cluster.integration.test.ts` | Five in-process pods through scale-ups, kills and graceful stops; every message stored once, trips identical to one uninterrupted ingestor. Writes `results/cluster-chaos.json` |
| `test/observability.test.ts` | `/metrics` output, and that every metric used by the alerts and dashboard exists |

One known flake: in one independent run `test/cluster.integration.test.ts` hung past its 120 s limit (it normally takes about 5 s). A likely cause was fixed, a graceful disconnect that could stall after the ingestor closed, and it now has a 2 s bound. It never reproduced locally.

## Rules, chart and dashboard

```bash
promtool test rules deploy/prometheus/rules.test.yaml
helm lint charts/telemetry -f charts/telemetry/values-ci.yaml
helm template t charts/telemetry -f charts/telemetry/values-ci.yaml | kubeconform -strict -ignore-missing-schemas -summary
bash scripts/check-grafana.sh   # loads the dashboard into Grafana in Docker, port 23000
```

## Accuracy sweep

`npm run accuracy -- --seeds 20 --devices 50` runs many seeded fleets and writes the distance error distribution to `results/accuracy.json`. Results are in PERFORMANCE.md.

## Fault-injection suite

```bash
npm run test:chaos                    # every scenario, seeds 1..5 (CHAOS_SEEDS=10 for more)
npm run chaos:matrix -- --seeds 5     # same runs as a script; --scenarios db-partition,sigkill-ingest
```

Both need Docker with the compose plugin. They start `docker-compose.chaos.yml` (Mosquitto, Postgres, the service image, and Toxiproxy in front of the broker and database links), run each scenario per seed and tear it down (`CHAOS_KEEP=1` or `--keep` keeps it). If the current user can't reach the Docker daemon the harness falls back to `sudo -n docker`; `CHAOS_DOCKER` overrides the command.

Each run publishes a seeded 8-vehicle fleet at 1500 messages/s, injects the fault after 30% of it, waits until everything is stored, and then checks that nothing was lost, nothing stored twice, and that trips, idle segments and late flags are identical to a fault-free run of the same seed.

| Scenario | Fault |
| --- | --- |
| `sigkill-ingest` | `docker kill -s KILL` on the service, `docker start` 1.5 s later |
| `sigterm-ingest` | `docker stop` under load, then `docker start`; it must exit 0 |
| `mosquitto-restart` | `docker restart` on the broker |
| `postgres-restart` | `docker restart` on the database |
| `network-latency` | Toxiproxy latency on the database and MQTT links for 5 s |
| `db-partition` | Toxiproxy `timeout` toxic on the database link for 6 s |

Results go to `results/chaos/` and are summarised in [RESILIENCE.md](RESILIENCE.md).

## CI

`.github/workflows/ci.yml` runs on every push and pull request. The first job type-checks the service, scripts and web page, runs `npm test` and builds. If it passes, a second job runs `npm run test:chaos` against the Compose services and uploads `results/chaos/` as an artifact. `.github/workflows/k8s.yml` covers the chart, alert rules and the k3d chaos suite.
