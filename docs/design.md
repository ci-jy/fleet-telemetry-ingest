# Design notes

## Pipeline

Devices publish to Mosquitto with QoS 1. The service validates each message (zod schema, topic id must match payload id) and puts it on a bounded in-memory queue. Batches of up to 1000 messages or 20 ms run in one transaction each:

1. `INSERT points ... ON CONFLICT (device_id, seq) DO NOTHING RETURNING`, so only new messages continue.
2. The per-device reorder buffer releases messages in seq order and flags stragglers as late.
3. The per-device trip state machine (`step`) runs on the released messages.
4. Trips and idle segments are inserted, late flags updated, device state and reorder cursor upserted.
5. After `COMMIT`, every message of the batch is acknowledged to the broker.

Within a process, batches run one at a time, which keeps per-device ordering simple without locks.

## Trip state machine

Each message becomes one input: `off` (ignition off), `moving` (ignition on, speed at least 3 km/h), `stationary` (ignition on, slower), or `gap` (a synthetic input when the message comes more than 5 min after the previous one).

`step(state, point)` is a pure function returning the new state, transitions and events, so replaying the same ordered points always gives the same trips. Every transition is checked against this table and the unit tests cover every row.

| From | Input | To | Effect |
| --- | --- | --- | --- |
| parked | off | parked | remember parking position (anchor) |
| parked | stationary | parked | none |
| parked | moving | moving | start trip, measured from the parking position |
| parked | gap | parked | none |
| moving | moving | moving | add haversine distance |
| moving | stationary | idle | start idle period |
| moving | off | trip_ended | end trip (`ignition_off`) |
| moving | gap | trip_ended | end trip at the last point (`gap`), then re-evaluate the message |
| idle | stationary | idle | add distance (GPS drift) |
| idle | stationary, idle at least 30 min | trip_ended | end trip where idling began (`idle_timeout`) |
| idle | moving | moving | close idle period; recorded as an idle segment if at least 60 s |
| idle | off | trip_ended | close idle period, end trip (`ignition_off`) |
| idle | gap | trip_ended | end trip at the last point (`gap`); the unfinished idle period is dropped |
| trip_ended | moving | moving | start a new trip |
| trip_ended | stationary | parked | none |
| trip_ended | off | parked | remember parking position |
| trip_ended | gap | trip_ended | none |

Distance is the sum of haversine distances between consecutive applied points, measured from the parking position so a dropout right at departure doesn't lose the first leg. Duration runs from the first moving message to the trip-ending one. Idle time is the sum of the recorded idle segments. Moving time and average speed are derived in the API.

## Duplicates, reordering and late messages

Copies within one batch are removed before the insert. Copies across batches, and redeliveries after a restart, are dropped by `ON CONFLICT DO NOTHING`. Only rows the database reports as new reach the state machine.

The reorder buffer releases messages strictly in seq order. A missing number is waited for until the buffered head is 30 s older in event time than the newest message for that device, the buffer holds 500 messages, or the device has been quiet for 15 s of wall-clock time. Then it is skipped. The window uses device timestamps rather than arrival time, which is why the integration tests are deterministic.

A message that arrives after its slot was skipped is still stored, with its `late` column set, and it is not applied to the state machine. So the live result always equals a replay of `points WHERE NOT late ORDER BY seq`.

The 15 s quiet-time rule only counts while the pipeline is healthy (broker connected, database succeeding, consumer not paused), so an outage can't release buffers early.

## Recovery by replay

Every batch stores the device's reorder cursor (`devices.reorder_next_seq`). On startup, non-late points below the cursor are replayed through the state machine, starting from the end of the last persisted trip. Non-late points at or above the cursor go back into a rebuilt reorder buffer with the same cursor and event-time high-water mark. The rebuilt state is the state before the stop. Any trip the replay closes is written again, which is a no-op if it already exists.

## Delivery and failure handling

The subscriber uses QoS 1 with a persistent session. mqtt.js normally sends the PUBACK as soon as a message is handed over. Here the automatic PUBACK is suppressed (by wrapping the client's internal `_sendPacket`) and sent only after the batch has committed. If the process dies before the commit, even with SIGKILL, the broker redelivers.

A failure can hit while `COMMIT` is in flight, so the transaction may have committed after all. The devices of a failed batch are therefore rebuilt from the database before the retry. If the batch did commit, the retry sees its rows as duplicates and changes nothing.

Failed batches retry after 500 ms, doubling up to 5 s. node-postgres has connect and query timeouts so a partitioned database turns into errors instead of hangs, and a connection whose `ROLLBACK` fails is destroyed instead of returned to the pool.

When the queue is full (`INGEST_QUEUE_MAX`), the subscriber stops reading from the socket until the queue drains to half; the broker keeps queuing for the session. MQTT reconnects back off from 250 ms up to 5 s.

On SIGTERM or SIGINT the service stops taking messages, commits and acknowledges everything queued, disconnects and exits 0 (1 if it couldn't drain within `SHUTDOWN_TIMEOUT_MS`). Reorder buffers are not flushed; the next start rebuilds them.

## Partitions, leases and fencing

With `PARTITIONS` above 0, `src/cluster/partition.ts` hashes the device id with 32-bit FNV-1a modulo the partition count, and the simulator publishes to `telemetry/p<k>/<deviceId>`. A message on the wrong partition is rejected.

The owner of partition k connects with the fixed client id `fleet-ingest-p<k>`, MQTT 5, clean start off and a session expiry. Whoever owns it next resumes the same session, so the broker keeps queuing while nobody owns it.

`partition_leases` has one row per partition: `owner` (pod name plus a random incarnation id), `holder`, `token` and `expires_at`. A pod takes a row only if it is free, expired, or held by a dead incarnation of the same pod name. Every change of owner increments the token.

The first statement of every ingest transaction locks the batch's lease rows `FOR SHARE` and checks owner, token and expiry. A stale owner's batch is refused before it writes anything (`FencedError`), and its queued messages are dropped without acknowledgement so the broker redelivers them to the new owner. A takeover has to update the row, so it waits for any batch that already passed the check.

Every `LEASE_RENEW_MS` each pod heartbeats `ingest_members`, renews its leases and moves towards `ceil(partitions / live members)`. The leases live in the same Postgres as the data, so the fencing check and the writes it protects commit atomically.

A new owner rebuilds the partition's devices with the same replay used on restart.

## Metrics and alerts

`GET /metrics` exports message outcomes (stored, duplicate, invalid, late), dedupe rejections, a publish-to-commit histogram, queue depth and capacity, paused state, batch errors, fenced batches, and partition ownership and lease counters.

`deploy/prometheus/rules.yaml` defines five alerts: p95 publish-to-commit above 2 s for 5 min, a queue above 80% or a paused consumer for 2 min, more than 5% failed batches over 5 min, a partition unowned for more than 30 s, and an unscrapeable ingest pod for 1 min. `deploy/prometheus/rules.test.yaml` checks them with promtool. `deploy/grafana/fleet-ingest.json` is the dashboard.

## Other limitations

- A trip ended by a gap is only closed when the next message arrives, or at startup replay. There is no timer for devices that went silent.
- Mosquitto saves its persistence file every 5 s, so a broker killed with SIGKILL can lose up to 5 s of acknowledged messages. That case isn't among the scenarios.
- A consumer paused for longer than the 30 s keepalive reconnects and gets redeliveries. Safe, but wasteful.
- After a handoff, redelivered messages can arrive behind newer ones. In real time that's far inside the reorder window, but a replay compressed 30-40x can push them past it, and they get flagged late.
- Devices are trusted to send increasing sequence numbers. Resetting `seq` needs a new device id.
- Out of scope: authentication, multi-tenancy, managed cloud Kubernetes, database replication, custom-metric autoscaling, alert routing, map matching, real vehicle data.
