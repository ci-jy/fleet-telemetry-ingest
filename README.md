# fleet-telemetry-ingest

An MQTT ingestion service for vehicle telemetry, written in TypeScript on Node.js. Devices publish GPS
and status messages to a Mosquitto broker. The service validates each message and stores the raw
track in PostgreSQL. A replayable per-device state machine turns the stream into **trips** and
**idle segments**, even when messages arrive late, out of order, twice, or not at all. A REST API
and a small React page expose devices, trips and tracks.

The repository also contains:

- a seeded fleet simulator that produces ground-truth trips and injects faults;
- an integration test that replays a simulated fleet and checks the trips against ground truth;
- an MQTT publish-rate load test that measures latency from publish to stored row;
- a k6 load test for the API;
- a fault-injection suite that runs the service in Docker Compose with Toxiproxy, kills or
  restarts the service, the broker and the database mid-stream, adds latency and partitions the
  database link, and checks that no message is lost or stored twice and that every trip is
  identical to a fault-free run;
- a GitHub Actions workflow that type-checks, runs the unit tests, builds, and then runs the
  fault-injection suite.

Measured numbers are in [PERFORMANCE.md](PERFORMANCE.md) (throughput, latency, accuracy) and
[docs/RESILIENCE.md](docs/RESILIENCE.md) (fault scenarios, recovery times, queue depth).

## Architecture

```
 devices / simulator                       ingestion service (Node.js, one process)
 ───────────────────                       ───────────────────────────────────────────────────────────
  fleet/<id>/telemetry   ┌───────────┐     ┌─────────────┐   ┌──────────────────────────────────────┐
  JSON, QoS 1  ─────────▶│ Mosquitto │────▶│ MQTT client │──▶│ parse + zod schema validation        │
                         │  (Docker) │     │ (mqtt.js)   │   │ (topic id must match payload id)     │
                         └───────────┘     └─────────────┘   └──────────────────┬───────────────────┘
                                                                                │ bounded queue (10 000);
                                                                                │ consumer pauses when full
                                                                                ▼ micro-batches (≤1000 msgs / 20 ms)
                                           ┌──────────────────────── one transaction per batch ───────────────┐
                                           │ 1. INSERT points … ON CONFLICT (device_id, seq) DO NOTHING       │
                                           │    RETURNING → only new messages continue (duplicates stop here) │
                                           │ 2. per-device reorder buffer (by seq, 30 s event-time window)    │
                                           │    → releases messages in seq order; stragglers flagged late     │
                                           │ 3. per-device trip state machine (pure function `step`)          │
                                           │ 4. INSERT trips + idle_segments, UPDATE late flags,              │
                                           │    UPSERT device state and reorder cursor                        │
                                           │ 5. after COMMIT: PUBACK every message of the batch to the broker │
                                           └───────────────────────────────┬──────────────────────────────────┘
                                                                           ▼
                         ┌──────────────────────────── PostgreSQL (Docker) ───────────────────────────┐
                         │ points (PK device_id, seq) · trips (UNIQUE device_id, start_seq)           │
                         │ idle_segments (FK trips) · devices (current state, open trip summary)      │
                         └───────────────────────────────┬────────────────────────────────────────────┘
                                                         │
                     ┌───────────────────────────────────┴──────────────┐
                     │ REST API (Fastify)  /api/devices, /api/trips, …  │◀──── React (Vite) page
                     └──────────────────────────────────────────────────┘      served from web/dist
```

Source layout:

| Path | Contents |
| --- | --- |
| `src/domain/telemetry.ts` | Wire schema (zod), topic parsing |
| `src/domain/reorderBuffer.ts` | Per-device reorder buffer keyed by sequence number |
| `src/domain/tripStateMachine.ts` | Trip state machine, transition table, `replay()` |
| `src/domain/geo.ts` | Haversine distance, polyline length, destination point |
| `src/ingest/ingestor.ts` | Batching, transactions, retry with backoff, bounded queue, recovery by replay, graceful shutdown |
| `src/ingest/mqttSubscriber.ts` | MQTT subscription (QoS 1, persistent session, acknowledgement after commit, pause on full queue, reconnect backoff) |
| `src/db/` | Schema, SQL, node-postgres and PGlite adapters |
| `src/api/server.ts` | REST API and static hosting of the web page |
| `src/sim/` | Seeded fleet generator, fault injection, MQTT publisher |
| `src/chaos/` | Fault-injection harness: Docker and Toxiproxy control, scenarios, runner, invariant checker, results report |
| `scripts/` | `simulate.ts`, `mqtt-load.ts`, `accuracy.ts`, `chaos-matrix.ts` |
| `load/k6-api.js` | k6 API load test |
| `web/` | React + Vite page |
| `test/` | Vitest unit and integration tests |
| `test/chaos/` | Fault-injection suite, one file per scenario (needs Docker) |
| `Dockerfile`, `docker-compose.chaos.yml` | Service image and the fault-injection environment |
| `.github/workflows/ci.yml` | CI: type-check, unit tests, build, fault-injection suite |

## Message format

Topic `fleet/<deviceId>/telemetry`, JSON payload:

```json
{ "deviceId": "veh-0001", "seq": 1842, "ts": 1767600000000,
  "lat": 52.52, "lon": 13.405, "speedKph": 42.5, "ignition": true }
```

`seq` is a per-device counter that strictly increases. `(deviceId, seq)` is the idempotency key.
`ts` is the device's event time in epoch milliseconds. A message is rejected and counted as
invalid if its JSON is malformed, a field fails validation (ranges, types, unknown fields), or the
topic's device id differs from the payload's.

## Trip state machine

Each message is classified as one of the following inputs:

- `off`: ignition off.
- `moving`: ignition on, speed ≥ 3 km/h.
- `stationary`: ignition on, speed below that.
- `gap`: a synthetic input, raised when the message comes more than `gapMs` (5 min) after the
  previous one.

The state machine is a pure function, `step(state, point) → {state, transitions, events}`, so
replaying the same ordered points always gives the same trips. Every transition it takes is
checked against this table, and the unit tests exercise every row.

| From | Input | To | Effect |
| --- | --- | --- | --- |
| parked | off | parked | remember parking position (anchor) |
| parked | stationary | parked | none (engine on, not moving) |
| parked | moving | moving | start trip, measured from the parking position |
| parked | gap | parked | none |
| moving | moving | moving | add haversine distance |
| moving | stationary | idle | start idle period |
| moving | off | trip_ended | end trip (`ignition_off`) |
| moving | gap | trip_ended | end trip at the last point (`gap`), then re-evaluate the message |
| idle | stationary | idle | add distance (GPS drift) |
| idle | stationary, idle ≥ `maxIdleMs` (30 min) | trip_ended | end trip where idling began (`idle_timeout`) |
| idle | moving | moving | close idle period; recorded as an idle segment if ≥ `minIdleMs` (60 s) |
| idle | off | trip_ended | close idle period, end trip (`ignition_off`) |
| idle | gap | trip_ended | end trip at the last point (`gap`); the unfinished idle period is dropped |
| trip_ended | moving | moving | start a new trip |
| trip_ended | stationary | parked | none (trip end stays the parking position) |
| trip_ended | off | parked | remember parking position |
| trip_ended | gap | trip_ended | none |

How trip metrics are computed:

- **Distance** is the sum of haversine distances between consecutive applied points. It is
  measured from the parking position, so a dropout right at departure does not lose the first
  leg.
- **Duration** runs from the first moving message to the trip-ending message.
- **Idle time** is the sum of the recorded idle segments.
- **Moving time** and **average speed** are derived in the API.

### Late and duplicate messages

- **Duplicates.** The primary key `(device_id, seq)` makes inserts idempotent. Copies within one
  batch are removed before the insert. Copies across batches, or redeliveries after a restart, are
  dropped by `ON CONFLICT DO NOTHING`. Only rows the database reports as new reach the state
  machine.
- **Reordering.** Each device has a reorder buffer that releases messages strictly in `seq` order.
  A missing sequence number is waited for until either:
  - the buffered head is 30 s older (in event time) than the newest message seen for that device;
  - the buffer holds 500 messages;
  - the device has been quiet for 15 s of wall-clock time.

  After that the buffer skips the missing number.
- **Late messages.** A message that arrives after its slot was skipped is still stored (it is part
  of the raw track). Its `late` column is set, and it is not applied to the state machine. This
  guarantees that the live result equals a replay of `points WHERE NOT late ORDER BY seq`.

### Recovery by replay

On startup the service rebuilds each device's in-memory state from the database. Every batch
also stores the device's **reorder cursor** (`devices.reorder_next_seq`, the next sequence number
its reorder buffer waits for), so the stored points split cleanly:

- non-late points below the cursor were applied to the state machine. They are replayed, starting
  from the end of the last persisted trip in the same state the live state machine was in right
  after closing that trip;
- non-late points at or above the cursor were still waiting in the reorder buffer. They are put
  back into a rebuilt buffer with the same cursor and event-time high-water mark.

The rebuilt state is therefore exactly the state before the stop, and a missing message that
arrives after the restart is slotted in as if nothing had happened. Any trip the replay closes is
written again, which is a no-op if it already exists. Tests stop the service several times
mid-fleet without draining it and check that trips, idle segments and late flags are identical to
an uninterrupted run. (Rows written before the cursor column existed fall back to replaying every
stored point.)

### Delivery guarantees and failure handling

The goal is that a crash, restart or outage of any component loses nothing and stores nothing
twice, and that the trips come out exactly as they would have without the fault.

- **Acknowledge after commit.** The subscriber uses QoS 1 with a persistent session (fixed client
  id, `clean: false`). mqtt.js normally sends the PUBACK as soon as a message is handed over;
  here the automatic PUBACK is suppressed and sent only after the batch containing the message
  has committed. If the process dies (even with SIGKILL) before the commit, the broker still
  holds the message and redelivers it on the next connection. Acknowledgements are tied to the
  connection that delivered the message; after a reconnect the broker resends it and the new copy
  is acknowledged on its own.
- **Idempotent storage.** `(device_id, seq)` is the primary key, so redeliveries are dropped by
  `ON CONFLICT DO NOTHING` and never reach the state machine twice.
- **Transactions.** Each batch runs in one transaction: points, late flags, trips, idle segments,
  device states and reorder cursors. New device state is computed on copies and swapped in only
  after `COMMIT`.
- **Unknown commit outcome.** A failure can hit while `COMMIT` is in flight (connection reset,
  query timeout), in which case the transaction may have committed after all. The devices of a
  failed batch are therefore rebuilt from the database before the retry; if the batch did commit,
  the retry sees its rows as duplicates and changes nothing. A unit test makes chosen
  transactions commit and then report failure.
- **Retry with backoff.** Failed batches are retried after 500 ms, doubling up to 5 s. Batch
  triggers that pile up while a slow transaction is failing are coalesced into one, and new
  arrivals do not bring the retry forward.
  node-postgres is configured with connect and query timeouts, so a partitioned database turns
  into errors instead of hanging forever. A connection whose `ROLLBACK` fails, or that reports an
  error while checked out (for example the server shutting down), is destroyed instead of being
  returned to the pool.
- **Backpressure.** Messages wait for a batch in a bounded in-memory queue (`INGEST_QUEUE_MAX`,
  default 10 000). When it is full, the subscriber stops reading from the MQTT socket until the
  queue has drained to half. The broker keeps queuing for the persistent session meanwhile.
  `/api/stats` reports `pending`, `queueCapacity`, `queuePeak`, `paused` and `pauses`.
- **Reconnect.** MQTT reconnects back off from 250 ms, doubling up to 5 s. The first connection
  and the startup database steps also retry, for a bounded time (30 s and 60 s), after which the
  process exits with an error.
- **Graceful shutdown.** On SIGTERM or SIGINT the service stops taking messages and commits and
  acknowledges everything queued. Then it disconnects from the broker and exits 0 (1 if it could
  not drain within `SHUTDOWN_TIMEOUT_MS`). The reorder buffers are not flushed: their points are
  stored, and the next start rebuilds them.
- **Stale sweep and outages.** Quiet time only counts towards the 15 s stale flush while the
  pipeline is healthy (broker connected, database succeeding, consumer not paused). A broker or
  database outage therefore cannot cause buffers to be released early, which would turn later
  stragglers into late messages.

## Running it

Requirements: Node.js ≥ 20, Docker with the compose plugin, and optionally k6.

```bash
npm ci
npm run build                 # type-checks server + web, builds dist/ and web/dist/
docker compose up -d --wait   # Mosquitto on 127.0.0.1:21883, Postgres on 127.0.0.1:25432
npm start                     # API + web page on http://127.0.0.1:23000
```

Docker Compose uses host networking. Both containers bind to 127.0.0.1 on the ports above.

To publish a seeded synthetic fleet and compare the API's trips with ground truth:

```bash
npm run sim -- --seed 42 --devices 20 --trips 4 --check
# --speedup 60 publishes in compressed real time (1 simulated minute per second)
```

Open http://127.0.0.1:23000 to browse devices, their trips, and a trip's track (plain SVG, no
map tiles).

To run without Docker, start the service with `DATABASE_URL=pglite://memory`. This uses an
in-process Postgres (PGlite) whose data is lost on exit. An MQTT broker is still needed.

Configuration is through environment variables. Defaults are shown below.

| Variable | Default |
| --- | --- |
| `MQTT_URL` | `mqtt://127.0.0.1:21883` |
| `MQTT_TOPIC` | `fleet/+/telemetry` |
| `DATABASE_URL` | `postgres://fleet:fleet@127.0.0.1:25432/fleet` |
| `HOST`, `PORT` | `127.0.0.1`, `23000` |
| `TRIP_MOVING_KPH`, `TRIP_GAP_MS`, `TRIP_MIN_IDLE_MS`, `TRIP_MAX_IDLE_MS` | `3`, `300000`, `60000`, `1800000` |
| `REORDER_WINDOW_MS`, `STALE_FLUSH_MS` | `30000`, `15000` |
| `BATCH_MAX_SIZE`, `BATCH_MAX_DELAY_MS` | `1000`, `20` |
| `INGEST_QUEUE_MAX` | `10000` (queue bound; the consumer pauses when it is reached) |
| `RETRY_DELAY_MS`, `RETRY_MAX_DELAY_MS` | `500`, `5000` (batch retry backoff) |
| `DB_CONNECT_TIMEOUT_MS`, `DB_QUERY_TIMEOUT_MS` | `5000`, `15000` |
| `MQTT_CLIENT_ID` | `fleet-ingest` (identifies the persistent session) |
| `MQTT_RECONNECT_MIN_MS`, `MQTT_RECONNECT_MAX_MS` | `250`, `5000` |
| `SHUTDOWN_TIMEOUT_MS` | `10000` (time allowed to drain on SIGTERM) |
| `WEB_DIST` | `web/dist` (empty string disables static hosting) |

For frontend development, run `npm run dev:web`. This starts Vite on port 25173 and proxies `/api`
to the service.

### REST API

| Endpoint | Description |
| --- | --- |
| `GET /health` | Database round trip |
| `GET /api/stats` | Stored counts and live ingest counters (received, invalid, duplicates, late, queue depth and capacity, paused, failed batches, …) |
| `GET /api/devices` | Devices with state, last position, open-trip summary, trip count and total km |
| `GET /api/devices/:id` | One device plus totals (trips, km, duration, idle) |
| `GET /api/devices/:id/trips?from&to&limit` | Trips of a device, newest first |
| `GET /api/devices/:id/track?from&to&limit&includeLate` | Raw points of a device, in seq order |
| `GET /api/trips?from&to&limit` | Recent trips across devices |
| `GET /api/trips/:id` | Trip with distance, duration, idle/moving time, speeds and idle segments |
| `GET /api/trips/:id/track` | Raw points of a trip |

Invalid parameters return `400`. Unknown ids return `404`.

## Tests

```bash
npm test
```

The test suite runs entirely in process. It uses PGlite, a WASM build of Postgres, and an
in-process Aedes MQTT broker on a port between 20000 and 29999, so it needs no Docker.

| File | What it checks |
| --- | --- |
| `test/tripStateMachine.test.ts` | Every row of the transition table. Idle thresholds, idle timeout, gap handling, anchoring, purity and determinism of replay. Reordered, duplicate and late delivery through the reorder buffer. |
| `test/reorderBuffer.test.ts` | Release rules (contiguous, window, overflow, flush), late vs. duplicate classification, cloning |
| `test/geo.test.ts` | Haversine against known distances, antimeridian, polyline sums |
| `test/telemetry.test.ts` | Schema validation and topic matching |
| `test/ingestor.test.ts` | Storage in Postgres, dedup within and across batches and restarts, late flags, rollback and retry, recovery by replay, stale-buffer sweep |
| `test/resilience.test.ts` | Acknowledgement only after commit, rebuild after a failure whose commit outcome is unknown, exact buffer recovery across repeated crashes, graceful shutdown, queue bound and resume, stale sweep during an outage, MQTT redelivery of unacknowledged messages |
| `test/invariants.test.ts` | The fault-injection invariant checker: lost, duplicate and phantom rows, trip, idle-segment and late-flag differences |
| `test/fleetReplay.integration.test.ts` | Seeded 12-vehicle fleets (two seeds) with drops, outages, duplicates, reordering and late messages. Trip count must match ground truth exactly, and every trip distance must be within 1%. |
| `test/mqttFleet.integration.test.ts` | The same check for a 15-vehicle fleet published through a real MQTT broker. Malformed messages are rejected. |
| `test/api.test.ts` | All REST endpoints against an ingested fleet |

The accuracy sweep, `npm run accuracy -- --seeds 20 --devices 50`, runs many more seeded fleets.
It writes the distribution of distance errors to `results/accuracy.json`.

### Fault-injection suite

```bash
npm run test:chaos                    # every scenario, seeds 1..5 (CHAOS_SEEDS=10 for more)
npm run chaos:matrix -- --seeds 5     # same runs as a script; --scenarios db-partition,sigkill-ingest
```

Both need Docker with the compose plugin. They build the service image, start
`docker-compose.chaos.yml`, run each scenario for each seed and tear the environment down
(`CHAOS_KEEP=1` or `--keep` leaves it running). If the current user cannot reach the Docker daemon,
the harness falls back to `sudo -n docker`; `CHAOS_DOCKER` overrides the command. Results are
written to `results/chaos/<scenario>.json` and `results/chaos/summary.md`.

```
  test driver (vitest / tsx, on the host)
   │  publishes the seeded fleet          │ reads rows, checks invariants      │ docker kill / restart
   ▼                                      ▼                                    │ Toxiproxy HTTP API
 Mosquitto :21884 ◀── Toxiproxy :21885 ── ingest service :23001 ── Toxiproxy :25435 ──▶ PostgreSQL :25434
   (persistent sessions)  (mqtt proxy)    (Docker image)            (postgres proxy)
```

Each run:

1. Stops the service, clears the database and the service's broker session, and starts the
   service.
2. Generates the fleet for the seed, with the simulator's link faults (drops, outages,
   duplicates, reordering, late messages). It publishes the deliveries in order at 1500
   messages/s and injects the scenario's fault after 30% of them.
3. Waits until every message is stored and every reorder buffer has been released.
4. Checks the invariants (`src/chaos/invariants.ts`):
   - every (device, seq) the simulator delivered is stored (**lost = 0**);
   - nothing is stored twice and nothing extra is stored (**duplicates = 0**);
   - trips, idle segments and late flags are **identical** to a fault-free run of the same seed
     through the same environment.
5. Records the fault's downtime, the recovery time (from healing the fault until the service
   commits new rows), the catch-up time (until the backlog published before the heal is stored)
   and the peak queue depth.

| Scenario | Fault |
| --- | --- |
| `sigkill-ingest` | `docker kill -s KILL` on the service mid-stream; 1.5 s later `docker start` |
| `sigterm-ingest` | `docker stop` (SIGTERM) on the service under load, then `docker start`; it must exit 0 |
| `mosquitto-restart` | `docker restart` on the broker |
| `postgres-restart` | `docker restart` on the database |
| `network-latency` | Toxiproxy latency: 250 ± 100 ms on the database link, 150 ± 50 ms on the MQTT link, both directions, 5 s |
| `db-partition` | Toxiproxy `timeout` toxic (data dropped, connections hang) on both directions of the database link for 6 s |

Scenario matrix and measured results: [docs/RESILIENCE.md](docs/RESILIENCE.md).

### Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request. The first job type-checks the
service, scripts and web page, runs `npm test` and builds. The second job, which runs only if
the first passes, runs `npm run test:chaos` against the Compose services and uploads
`results/chaos/` as an artifact.

## Simulator and ground truth

`src/sim/fleet.ts` generates each vehicle from a fixed seed. Each vehicle goes through these
phases:

1. It parks, sending a heartbeat every minute with the ignition off.
2. It warms up with the engine on.
3. It drives a smooth random route, reporting every 5 s. The drive includes short traffic stops
   and 0–2 deliberate stops of 2–6 minutes with the engine running.
4. It arrives, switches the ignition off and parks again.

The ground truth for each trip is its start and end time, its idle time, and the length of the
polyline through all the positions the device reported.

`injectFaults` then degrades the stream with these defaults:

- 2% random drops;
- connectivity outages of 30–120 s;
- 5% duplicates, some delivered minutes later;
- 10% of messages delayed by up to 20 s;
- 0.2% of messages delayed by 90 s, which makes them late.

## Design notes

- **One process, one batch at a time.** Batches are processed serially, which preserves
  per-device ordering without locks. Throughput comes from batching: a single `unnest` insert
  handles up to 1000 points. Parallelism would need partitioning by device, for example one
  consumer per topic shard.
- **Event-time windows.** The reorder buffer's window uses device timestamps, not arrival time.
  The result therefore does not depend on how fast messages are replayed, which is why the
  integration tests are deterministic. A wall-clock sweep releases buffers of devices that went
  quiet.
- **QoS 1 with a persistent session, acknowledged after commit.** The broker keeps messages
  while the service is down and redelivers anything not yet acknowledged. Because storage is
  idempotent, at-least-once delivery is enough. Exactly-once results come from idempotent keys
  plus deterministic, restartable per-device state, not from the transport.
- **Faults are tested against a reference run, not against tolerances.** Each fault run is
  compared field by field with a fault-free run of the same seed. A small drift in a distance
  would therefore show up as a failure instead of passing inside an error margin.
- **PGlite for tests.** The SQL path, including `ON CONFLICT`, `unnest` and transactions, is
  tested against a real Postgres engine without external services. The production adapter uses
  node-postgres with `int8` mapped to numbers.

## Limitations

- **Distance across dropouts.** Across a dropout or outage, distance is the straight-line chord
  between the last point before and the first point after. On a curvy road this underestimates.
  In the 20-seed sweep, 99.2% of trips are within 1% of ground truth and the worst is 2.1% off
  (see PERFORMANCE.md). Estimating from reported speed was tried and rejected: it overestimates
  when the outage hides a stop. There is no map matching.
- **Gap-ended trips.** A trip ended by a gap is closed only when the next message arrives, or at
  startup replay. There is no wall-clock timer that closes trips of devices that went silent.
- **Acknowledgement hook.** mqtt.js has no public API for delaying a PUBACK. The subscriber wraps
  the client's internal `_sendPacket` to suppress the automatic PUBACK. A test covers it, but a
  major mqtt.js upgrade could break it.
- **Broker durability.** Mosquitto writes its persistence file on shutdown and every 5 s
  (`autosave_interval` in the chaos configuration). A graceful broker restart keeps every queued
  message. A broker killed with SIGKILL can lose up to 5 s of acknowledged messages, so that case
  is not among the scenarios.
- **Long pauses.** While the consumer is paused it does not read from the socket, so it does not
  see the broker's keepalive responses. A pause longer than the 30 s keepalive makes the client
  reconnect, and the broker then redelivers. That is safe but wasteful.
- **Wall-clock dependence.** Trips are identical across faults because each device's results
  depend only on the order in which its messages first arrive. The one wall-clock rule, the stale
  flush, is suspended during outages. A device that is genuinely silent for longer than
  `STALE_FLUSH_MS` while a straggler is still on its way will still see that straggler marked
  late, with or without faults.
- **Fault-injection scale.** Each run is a fleet of 8 vehicles with 3 trips each (about 7 000
  deliveries) on one machine, with one fault per run. The scenarios do not cover disk-full
  conditions, clock skew or several faults at once.
- **Single instance.** Running two instances on the same topic would split a device's messages
  between them. Horizontal scaling would need sharding by device.
- **Clock and sequence assumptions.** Devices are trusted to send monotonically increasing
  sequence numbers. Resetting `seq` (for example after a factory reset) needs a new device id.
- **Out of scope:** authentication, multi-tenancy, cloud deployment, Kubernetes, database
  replication, map matching or routing, and real vehicle data.

## License

MIT. Third-party packages are used as npm dependencies under their own licenses. No third-party
source code is vendored.

Project period: 2026-05-04 to 2026-06-05.
