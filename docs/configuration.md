# Configuration, API and message format

## Message format

Topic `fleet/<deviceId>/telemetry` (or `telemetry/p<k>/<deviceId>` in partitioned mode), JSON payload:

```json
{ "deviceId": "veh-0001", "seq": 1842, "ts": 1767600000000,
  "lat": 52.52, "lon": 13.405, "speedKph": 42.5, "ignition": true }
```

`seq` is a per-device counter that strictly increases, and `(deviceId, seq)` is the idempotency key. `ts` is the device's event time in epoch milliseconds. A message is rejected and counted as invalid if its JSON is malformed, a field fails validation (ranges, types, unknown fields), or the topic's device id differs from the payload's.

## Environment variables

| Variable | Default |
| --- | --- |
| `MQTT_URL` | `mqtt://127.0.0.1:21883` |
| `MQTT_TOPIC` | `fleet/+/telemetry` |
| `DATABASE_URL` | `postgres://fleet:fleet@127.0.0.1:25432/fleet` (`pglite://memory` for an in-process database that is lost on exit) |
| `HOST`, `PORT` | `127.0.0.1`, `23000` |
| `TRIP_MOVING_KPH`, `TRIP_GAP_MS`, `TRIP_MIN_IDLE_MS`, `TRIP_MAX_IDLE_MS` | `3`, `300000`, `60000`, `1800000` |
| `REORDER_WINDOW_MS`, `STALE_FLUSH_MS` | `30000`, `15000` |
| `BATCH_MAX_SIZE`, `BATCH_MAX_DELAY_MS` | `1000`, `20` |
| `INGEST_QUEUE_MAX` | `10000` (the consumer pauses when the queue is full) |
| `RETRY_DELAY_MS`, `RETRY_MAX_DELAY_MS` | `500`, `5000` (batch retry backoff) |
| `DB_CONNECT_TIMEOUT_MS`, `DB_QUERY_TIMEOUT_MS` | `5000`, `15000` |
| `MQTT_CLIENT_ID` | `fleet-ingest` (identifies the persistent session) |
| `MQTT_RECONNECT_MIN_MS`, `MQTT_RECONNECT_MAX_MS` | `250`, `5000` |
| `SHUTDOWN_TIMEOUT_MS` | `10000` (time allowed to drain on SIGTERM) |
| `WEB_DIST` | `web/dist` (empty string disables static hosting) |
| `PARTITIONS` | `0` (single instance); above 0 the service consumes `telemetry/p<k>/+` through leased partitions |
| `LEASE_TTL_MS`, `LEASE_RENEW_MS` | `10000`, `2000` |
| `POD_NAME` | `$HOSTNAME` (lease holder; a restarted pod with the same name reclaims its leases) |
| `MQTT_SESSION_EXPIRY_S` | `86400` (MQTT 5 session expiry of the partition sessions) |

For frontend work, `npm run dev:web` starts Vite on port 25173 and proxies `/api` to the service.

## REST API

| Endpoint | Description |
| --- | --- |
| `GET /health` | Database round trip |
| `GET /api/stats` | Stored counts and live ingest counters (received, invalid, duplicates, late, queue depth and capacity, paused, failed batches) |
| `GET /api/devices` | Devices with state, last position, open-trip summary, trip count and total km |
| `GET /api/devices/:id` | One device plus totals (trips, km, duration, idle) |
| `GET /api/devices/:id/trips?from&to&limit` | Trips of a device, newest first |
| `GET /api/devices/:id/track?from&to&limit&includeLate` | Raw points of a device, in seq order |
| `GET /api/trips?from&to&limit` | Recent trips across devices |
| `GET /api/trips/:id` | Trip with distance, duration, idle and moving time, speeds and idle segments |
| `GET /api/trips/:id/track` | Raw points of a trip |
| `GET /metrics` | Prometheus metrics |

Invalid parameters return `400`. Unknown ids return `404`. `/api/devices` has no pagination and is the slowest endpoint under load (see PERFORMANCE.md).
