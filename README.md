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
- a k6 load test for the API.

Measured numbers are in [PERFORMANCE.md](PERFORMANCE.md).

## Architecture

```
 devices / simulator                       ingestion service (Node.js, one process)
 ───────────────────                       ───────────────────────────────────────────────────────────
  fleet/<id>/telemetry   ┌───────────┐     ┌─────────────┐   ┌──────────────────────────────────────┐
  JSON, QoS 1  ─────────▶│ Mosquitto │────▶│ MQTT client │──▶│ parse + zod schema validation        │
                         │  (Docker) │     │ (mqtt.js)   │   │ (topic id must match payload id)     │
                         └───────────┘     └─────────────┘   └──────────────────┬───────────────────┘
                                                                                │ micro-batches
                                                                                ▼ (≤1000 msgs / 20 ms)
                                           ┌──────────────────────── one transaction per batch ───────────────┐
                                           │ 1. INSERT points … ON CONFLICT (device_id, seq) DO NOTHING       │
                                           │    RETURNING → only new messages continue (duplicates stop here) │
                                           │ 2. per-device reorder buffer (by seq, 30 s event-time window)    │
                                           │    → releases messages in seq order; stragglers flagged late     │
                                           │ 3. per-device trip state machine (pure function `step`)          │
                                           │ 4. INSERT trips + idle_segments, UPDATE late flags,              │
                                           │    UPSERT device state                                           │
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
| `src/ingest/ingestor.ts` | Batching, transactions, retry, recovery by replay |
| `src/ingest/mqttSubscriber.ts` | MQTT subscription (QoS 1, persistent session) |
| `src/db/` | Schema, SQL, node-postgres and PGlite adapters |
| `src/api/server.ts` | REST API and static hosting of the web page |
| `src/sim/` | Seeded fleet generator, fault injection, MQTT publisher |
| `scripts/` | `simulate.ts`, `mqtt-load.ts`, `accuracy.ts` |
| `load/k6-api.js` | k6 API load test |
| `web/` | React + Vite page |
| `test/` | Vitest unit and integration tests |

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

On startup the service rebuilds each device's in-memory state. It starts from the end of the last
persisted trip, in the same state the live state machine was in right after closing that trip,
and replays the stored, non-late points that follow. Any trip the replay closes is written again,
which is a no-op if it already exists. A test stops the service mid-fleet without draining it, so
some reorder buffers still hold messages. It then restarts and checks that the trip boundaries
match those of an uninterrupted run.

### Transactions and failure handling

Each batch runs in one transaction: points, late flags, trips, idle segments and device states.
New device state is computed on copies and swapped in only after `COMMIT`. If a batch fails,
nothing is visible in the database, memory is unchanged, and the batch is put back and retried. A
test injects a failure on the trip insert to check this.

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
| `WEB_DIST` | `web/dist` (empty string disables static hosting) |

For frontend development, run `npm run dev:web`. This starts Vite on port 25173 and proxies `/api`
to the service.

### REST API

| Endpoint | Description |
| --- | --- |
| `GET /health` | Database round trip |
| `GET /api/stats` | Stored counts and live ingest counters (received, invalid, duplicates, late, …) |
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
| `test/fleetReplay.integration.test.ts` | Seeded 12-vehicle fleets (two seeds) with drops, outages, duplicates, reordering and late messages. Trip count must match ground truth exactly, and every trip distance must be within 1%. |
| `test/mqttFleet.integration.test.ts` | The same check for a 15-vehicle fleet published through a real MQTT broker. Malformed messages are rejected. |
| `test/api.test.ts` | All REST endpoints against an ingested fleet |

The accuracy sweep, `npm run accuracy -- --seeds 20 --devices 50`, runs many more seeded fleets.
It writes the distribution of distance errors to `results/accuracy.json`.

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
- **QoS 1 with a persistent session.** The broker keeps messages while the service is down.
  Because storage is idempotent, at-least-once delivery is enough.
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
- **Late messages around restarts.** After a restart, the reorder cursor starts after the highest
  stored sequence number. A few stragglers that would have been slotted in can therefore be
  classified as late, which shifts the affected trip's distance slightly. The ingestor test
  bounds this at 0.1%.
- **Single instance.** Running two instances on the same topic would split a device's messages
  between them. Horizontal scaling would need sharding by device.
- **Clock and sequence assumptions.** Devices are trusted to send monotonically increasing
  sequence numbers. Resetting `seq` (for example after a factory reset) needs a new device id.
- **Out of scope:** authentication, multi-tenancy, cloud deployment, map matching or routing, and
  real vehicle data.

## License

MIT. Third-party packages are used as npm dependencies under their own licenses. No third-party
source code is vendored.
