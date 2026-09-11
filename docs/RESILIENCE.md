# Resilience: fault scenarios and measured results

This document describes what the fault-injection suite does and what it measured. The suite
crashes, restarts or degrades each component of the pipeline in the middle of a stream of
telemetry. After each run it checks three things:

- no message was lost;
- no message was stored twice;
- the trips are exactly those of a run without the fault.

How the service achieves this is described in the README under *Delivery guarantees and failure
handling*.

## Environment

`docker-compose.chaos.yml` runs four containers with host networking. Every port is bound to
127.0.0.1.

| Component | Image | Address |
| --- | --- | --- |
| Mosquitto (persistent sessions, autosave every 5 s, 5000 in-flight per client) | `eclipse-mosquitto:2` | `:21884` |
| PostgreSQL | `postgres:16-alpine` | `:25434` |
| Toxiproxy (`mqtt` proxy `:21885 → :21884`, `postgres` proxy `:25435 → :25434`) | `ghcr.io/shopify/toxiproxy:2.12.0` | API `:28474` |
| Ingest service (built from `Dockerfile`) | `fleet-telemetry-ingest:chaos` | HTTP `:23001` |

The service reaches the broker and the database only through Toxiproxy. The test driver runs on
the host. It publishes straight to Mosquitto, reads straight from PostgreSQL, and polls the
service's `/api/stats` every 100 ms for queue depth.

Service settings in this environment:

- queue bound `INGEST_QUEUE_MAX=2000`, chosen so that outages actually fill it;
- `STALE_FLUSH_MS=5000`;
- database connect and query timeouts of 2 s;
- batch retry backoff from 200 ms to 2 s;
- MQTT reconnect backoff from 200 ms to 2 s.

## Workload and ground truth

Each seed produces a fleet from the existing simulator (`src/sim/fleet.ts`): 8 vehicles with 3
trips each. The simulator's link faults are on (`injectFaults`, seed + 1):

- 2% drops;
- connectivity outages;
- 5% duplicates;
- 10% reordered by up to 20 s;
- 0.2% late by 90 s.

That gives 6,300–7,500 deliveries and about 7,000 distinct `(device, seq)` pairs per seed. They
are published in delivery order at 1,500 messages/s over one QoS 1 connection. The fault is
injected once 30% of the deliveries have been published.

The ground truth for storage is the set of `(device, seq)` pairs the simulator delivered. The
reference for trips is a **fault-free run of the same seed through the same environment**,
recorded once per suite run. The trips, idle segments and late flags of every fault run must
match that reference field by field: start and end sequence numbers, timestamps, distance (to
1e-9 relative), duration, idle time, point count, maximum speed and end reason.

## Scenario matrix

| Scenario | Fault | Healed when | What must hold |
| --- | --- | --- | --- |
| `sigkill-ingest` | `docker kill -s KILL` on the service while batches stream in; down for 1.5 s | `docker start` returns | Messages that were queued or in an uncommitted transaction were never acknowledged, so the broker redelivers them. Reorder buffers are rebuilt from stored points and the persisted cursor. |
| `sigterm-ingest` | `docker stop` (SIGTERM, 20 s grace) on the service under load; down for 0.5 s | `docker start` returns | The service stops consuming, commits and acknowledges its queue, disconnects and exits with status **0**. |
| `mosquitto-restart` | `docker restart` on the broker | the restart returns | The broker restores sessions and queued messages from its persistence file. The publisher resends unacknowledged publishes. The service reconnects with backoff and resumes its session. |
| `postgres-restart` | `docker restart` on the database | the restart returns | In-flight transactions fail and connections are terminated. The service survives (no crash on a client error), rebuilds the devices of the failed batch from the database and retries with backoff. |
| `network-latency` | Toxiproxy `latency` toxics: 250 ± 100 ms on the database link and 150 ± 50 ms on the MQTT link, both directions, for 5 s | toxics removed | Batches slow down and the queue fills to its bound. The consumer pauses and resumes without losing or reordering anything. |
| `db-partition` | Toxiproxy `timeout` toxics with timeout 0 (bytes silently dropped, connections hang) on both directions of the database link for 6 s | toxics removed | Queries hit the 2 s timeout and hung connections are destroyed. The consumer pauses at 2,000 queued messages. Some failures may happen while `COMMIT` is in flight; the rebuild before the retry covers that case. |

Definitions used in the results:

- **Downtime**: from injecting the fault to healing it.
- **Recovery**: from healing the fault to the first newly committed row, sampled every 50 ms.
- **Catch-up**: from healing the fault until as many rows are stored as distinct messages had
  been published before the heal, i.e. until the backlog is gone.
- **Peak queue**: the highest in-memory queue depth seen, out of a capacity of 2,000.
- **Failed batches**: counted by the service process that finished the run. After SIGKILL or
  SIGTERM that is the new process.

## Results

Measured on 2026-10-05 with `npm run test:chaos` (seeds 1–5) on one machine: 4 vCPUs, Node.js
v26.9.0 for the driver and Node.js 22 in the service image. Raw results are in
`results/chaos/<scenario>.json`. The table is `results/chaos/summary.md`, which the suite
regenerates on every run.

**All 30 runs passed: 0 lost messages, 0 duplicate rows, and all 24 trips per seed identical to
the fault-free run, together with their idle segments and late flags.**

<!-- chaos-summary:start (generated by scripts/sync-results.py from results/chaos/summary.md) -->
| Scenario | Runs | Passed | Lost | Duplicate rows | Trips identical | Median recovery s | Max recovery s | Median catch-up s | Max peak queue |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| sigkill-ingest | 5 | 5 | 0 | 0 | all | 0.37 | 0.41 | 0.52 | 2000 |
| sigterm-ingest | 5 | 5 | 0 | 0 | all | 0.39 | 0.49 | 0.46 | 2000 |
| mosquitto-restart | 5 | 5 | 0 | 0 | all | 0.39 | 0.49 | 0.39 | 1372 |
| postgres-restart | 5 | 5 | 0 | 0 | all | 0.16 | 0.18 | 0.61 | 2000 |
| network-latency | 5 | 5 | 0 | 0 | all | 0.07 | 0.09 | 0.24 | 2000 |
| db-partition | 5 | 5 | 0 | 0 | all | 0.52 | 0.58 | 0.81 | 2045 |

| Scenario | Seed | Messages delivered | Unique | Lost | Duplicate rows | Trips (match fault-free) | Downtime s | Recovery s | Catch-up s | Peak queue | Paused | Failed batches | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | --- |
| sigkill-ingest | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 2.16 | 0.35 | 0.50 | 2000 / 2000 | yes | 0 | pass |
| sigkill-ingest | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 2.28 | 0.41 | 0.56 | 2000 / 2000 | yes | 0 | pass |
| sigkill-ingest | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 2.25 | 0.38 | 0.53 | 2000 / 2000 | yes | 0 | pass |
| sigkill-ingest | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 2.22 | 0.36 | 0.52 | 2000 / 2000 | yes | 0 | pass |
| sigkill-ingest | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 2.29 | 0.37 | 0.52 | 2000 / 2000 | yes | 0 | pass |
| sigterm-ingest | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 1.40 | 0.35 | 0.40 | 2000 / 2000 | yes | 0 | pass |
| sigterm-ingest | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 1.42 | 0.36 | 0.46 | 1558 / 2000 | no | 0 | pass |
| sigterm-ingest | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 1.31 | 0.46 | 0.56 | 2000 / 2000 | yes | 0 | pass |
| sigterm-ingest | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 1.43 | 0.39 | 0.44 | 2000 / 2000 | yes | 0 | pass |
| sigterm-ingest | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 1.39 | 0.49 | 0.55 | 1669 / 2000 | no | 0 | pass |
| mosquitto-restart | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 0.65 | 0.39 | 0.39 | 934 / 2000 | no | 0 | pass |
| mosquitto-restart | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 0.61 | 0.46 | 0.46 | 1341 / 2000 | no | 0 | pass |
| mosquitto-restart | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 0.65 | 0.49 | 0.49 | 1343 / 2000 | no | 0 | pass |
| mosquitto-restart | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 0.71 | 0.35 | 0.35 | 1372 / 2000 | no | 0 | pass |
| mosquitto-restart | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 0.66 | 0.39 | 0.39 | 1358 / 2000 | no | 0 | pass |
| postgres-restart | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 2.10 | 0.18 | 1.25 | 2000 / 2000 | yes | 4 | pass |
| postgres-restart | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 1.15 | 0.16 | 0.62 | 2000 / 2000 | yes | 3 | pass |
| postgres-restart | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 1.14 | 0.15 | 0.61 | 2000 / 2000 | yes | 3 | pass |
| postgres-restart | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 1.17 | 0.16 | 0.57 | 2000 / 2000 | yes | 3 | pass |
| postgres-restart | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 1.14 | 0.14 | 0.60 | 2000 / 2000 | yes | 3 | pass |
| network-latency | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 5.02 | 0.03 | 0.28 | 2000 / 2000 | yes | 0 | pass |
| network-latency | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 5.01 | 0.09 | 0.24 | 2000 / 2000 | yes | 0 | pass |
| network-latency | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 5.01 | 0.07 | – | 2000 / 2000 | yes | 0 | pass |
| network-latency | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 5.01 | 0.07 | 0.28 | 2000 / 2000 | yes | 0 | pass |
| network-latency | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 5.00 | 0.06 | 0.21 | 2000 / 2000 | yes | 0 | pass |
| db-partition | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 6.01 | 0.50 | 0.81 | 2022 / 2000 | yes | 2 | pass |
| db-partition | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 6.01 | 0.52 | 0.77 | 2045 / 2000 | yes | 2 | pass |
| db-partition | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 6.01 | 0.58 | 0.96 | 2030 / 2000 | yes | 2 | pass |
| db-partition | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 6.00 | 0.57 | 0.89 | 2022 / 2000 | yes | 2 | pass |
| db-partition | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 6.00 | 0.47 | 0.67 | 2026 / 2000 | yes | 2 | pass |

"–" means the catch-up point was not captured by the 50 ms sampler in that run.
<!-- chaos-summary:end -->

## Reading the results

- **SIGKILL.** At the kill, a few dozen messages at most were queued in memory and a batch was usually in flight.
  None of them had been acknowledged, so the broker redelivered them to the restarted service.
  A few hundred redelivered or simulator-duplicated copies per run were discarded by the primary
  key. The restarted service rebuilt every reorder buffer from the stored points and the persisted
  cursor, so stragglers that arrived after the restart were slotted in exactly as in the
  fault-free run. Recovery (measured from when `docker start` returned; see the table) is the time the service
  needed to start: connect, migrate, replay devices and subscribe. The backlog then fills the
  2,000-message queue and the consumer pauses until it drains.
- **SIGTERM.** Every graceful stop exited with status 0 after committing and acknowledging its
  queue. The reorder buffers are deliberately not flushed on shutdown, so the result is the same
  as never stopping.
- **Mosquitto restart.** The broker was unavailable for under a second (the downtime column). Its persistence file kept the
  service's session and queued messages. The publisher resent its unacknowledged publishes, and
  the service reconnected with backoff and resumed its session. No batch failed.
- **PostgreSQL restart.** The database refused connections for one to two seconds. The service saw a handful of
  failed batches (the failed-batches column), rebuilt the 8 affected devices from the database before each retry, and kept
  the retry backoff while new messages arrived. An earlier version of the suite caught two bugs
  here. First, an error emitted by a checked-out pg client during the shutdown crashed the
  process. Second, batch triggers queued during a slow failing transaction ran back to back,
  which meant 60–120 failed attempts per restart instead of a handful.
- **Network latency.** With 250 ± 100 ms on the database link, batch commits slowed down enough
  to fill the queue. The consumer paused and resumed, and nothing failed.
- **Database partition.** With bytes silently dropped for 6 s, queries hit the 2 s timeout and
  hung connections were destroyed. Recovery after the heal (about half a second) is dominated by the retry
  backoff, which had grown to 2 s. The queue peaks slightly above its bound of 2,000 because
  MQTT messages already parsed from the current TCP read are still handed over after the pause
  begins.

## What is not covered

- **Broker SIGKILL.** Mosquitto saves its persistence file every 5 s and on shutdown, so a broker
  killed with SIGKILL can lose up to 5 s of messages it had already acknowledged to publishers.
  This is a property of the broker configuration, not of the service.
- **Combined faults.** Each run injects a single fault. Disk-full, clock skew, partial packet
  loss and long outages (longer than the 30 s MQTT keepalive while paused) are not scenarios.
- **Scale.** Runs are small (8 vehicles, about 7,000 messages, 1,500 msg/s) so the full matrix
  takes about 5 minutes (plus the image build), in CI as well. Throughput under load is measured separately in
  [PERFORMANCE.md](../PERFORMANCE.md).
- **Timing resolution.** Recovery and catch-up are sampled every 50 ms from outside the service,
  so they are accurate to roughly ±50 ms.

## Reproducing

```bash
npm ci
npm run test:chaos                          # all scenarios, seeds 1..5, writes results/chaos/
CHAOS_SEEDS=10 npm run test:chaos           # more seeds
npm run chaos:matrix -- --seeds 3 --scenarios db-partition,postgres-restart --keep
```
