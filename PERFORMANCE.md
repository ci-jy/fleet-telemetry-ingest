# Performance and accuracy

All numbers below come from real runs on a single machine on 2026-10-03:

- 4 vCPUs (Intel i5-13600K), 8 GB RAM, Node.js v26.9.0
- Mosquitto 2 and Postgres 16 in Docker (host networking)
- the ingestion service (`npm start`), the load generators and k6, all on the same host

They share CPU, so the figures are a lower bound for a deployment where these components run on
separate machines.

The raw results are committed in `results/`:

| File | Produced by |
| --- | --- |
| `results/mqtt-load.json` | `npm run load:mqtt` (`scripts/mqtt-load.ts`) |
| `results/k6-api-summary.json` | `npm run load:api` (`load/k6-api.js`) |
| `results/accuracy.json` | `npm run accuracy` (`scripts/accuracy.ts`) |
| `results/chaos/*.json`, `results/chaos/summary.md` | `npm run test:chaos` (fault injection, see [docs/RESILIENCE.md](docs/RESILIENCE.md)) |

## Ingest: MQTT publish → stored row

Setup:

```bash
docker compose up -d --wait && npm run build && npm start   # in one terminal
npm run load:mqtt -- --rates 1000,5000,10000,15000,20000,25000 --duration 30 --devices 1000
```

How the test works:

- 1000 simulated vehicles send realistic streams (parking, driving, idling), so every message goes
  through validation, the idempotent insert, the reorder buffer and the trip state machine.
- Messages are published at a fixed offered rate over 4 MQTT connections with QoS 1.
- For every message, latency is measured from the publish call to `points.stored_at`. That column
  is `clock_timestamp()` taken inside the inserting transaction.
- Throughput is the number of stored rows divided by the time from the first publish to the last
  stored row.

| Offered (msg/s) | Published | Stored | Throughput (rows/s) | p50 (ms) | p95 (ms) | p99 (ms) | max (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 30,000 | 30,000 | 998.9 | 14.4 | 28.7 | 31.3 | 48.2 |
| 5,000 | 150,000 | 150,000 | 4,991.3 | 14.6 | 35.6 | 43.1 | 62.0 |
| 10,000 | 300,000 | 300,000 | 9,986.5 | 27.8 | 49.0 | 59.5 | 92.5 |
| 15,000 | 450,000 | 450,000 | 14,973.7 | 30.3 | 51.4 | 62.1 | 86.7 |
| 20,000 | 600,000 | 600,000 | 19,976.5 | 57.2 | 232.9 | 253.4 | 277.6 |
| 25,000 | 750,000 | 750,000 | 20,265.3 | 3,255.6 | 6,412.9 | 6,951.3 | 7,018.3 |

These are measured with the service acknowledging each message to the broker only after its
batch has committed (see the README, *Delivery guarantees and failure handling*). The broker
allows 10,000 unacknowledged messages per client (`infra/mosquitto/mosquitto.conf`).

What the results show:

- **No message was lost at any rate.** Every published message was stored exactly once.
- **Up to 15,000 msg/s** the service keeps up, with p95 around 51 ms or less. Much of that latency
  is the batching delay (up to 20 ms) plus the transaction commit.
- **At 20,000 msg/s** it still keeps up, but p95 rises to about 233 ms.
- **At 25,000 msg/s** the service saturates at about 20,300 rows/s. A backlog builds up and
  latency grows to seconds.
- **The in-flight window matters with acknowledgement after commit.** With the broker's earlier
  limit of 1,000 unacknowledged messages per client, the broker stopped sending during every
  commit. Throughput then saturated at about 13,000 rows/s, already at an offered 15,000 msg/s.
  At an offered 20,000 and 25,000 msg/s, only 489,072 of 600,000 and 496,357 of 750,000 messages
  were stored before the measurement window closed. The window was therefore raised to 10,000.
  Before acknowledgement moved after the commit, the same test saturated at about 22,000 rows/s;
  delaying the acknowledgement costs about 8% of peak throughput. The bottleneck is the single serial batch pipeline, which was chosen
  to keep per-device ordering simple (see the README design notes). Most of the CPU goes to
  Postgres inserts and JSON/schema parsing, which share four cores with the broker and the
  publishers.

## REST API (k6)

```bash
k6 run -e DURATION=60s -e RATE=200 load/k6-api.js
```

The test was run against the database left by the ingest test: about 6,050 devices, 2.34 million
points and 3,223 trips. It uses a constant arrival rate of 200 requests/s for 60 s. The request
mix is:

| Share | Endpoint |
| ---: | --- |
| 10% | `/api/devices` (the full device list, 6,050 rows) |
| 40% | device trips |
| 30% | trip detail |
| 15% | trip track |
| 5% | device detail |

| Requests | Throughput | Failed | avg | median | p90 | p95 | max |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 12,003 | 199.8 req/s | 0.00% | 14.2 ms | 3.9 ms | 41.6 ms | 52.8 ms | 164.0 ms |

All k6 thresholds passed (p95 < 250 ms, error rate < 1%). The slow tail comes from
`/api/devices`: it returns every device with an aggregate over all trips, and has no pagination.

## Trip accuracy against ground truth

```bash
npm run accuracy -- --seeds 20 --devices 50 --trips 4
```

The sweep runs 20 seeded fleets of 50 vehicles each, 4,000 trips in total, through the full
pipeline: PGlite storage, reorder buffer and state machine. It uses the default fault rates:

- 2% drops;
- 30–120 s outages;
- 5% duplicates;
- 10% of messages reordered by up to 20 s;
- 0.2% of messages 90 s late.

| Metric | Value |
| --- | --- |
| Trips expected / detected | 4,000 / 4,000 (no device with a count mismatch) |
| Distance error, median \|e\| | 0.01% |
| Distance error, p95 / p99 \|e\| | 0.35% / 0.87% |
| Distance error, max \|e\| | 2.14% |
| Trips within 1% | 3,968 of 4,000 (99.2%) |
| Fleet total distance error | −0.07% |
| Fleet total idle time error | +0.97% |

The trips outside 1% are all cases where an outage of up to 2 minutes cuts across a curvy part
of the route. The straight chord between the points on either side of the outage underestimates
the distance driven, which is why the mean error is slightly negative.

The seeded fleets used by `npm test` (seeds 42 and 1337 in-process, 2026 over MQTT) are all within
1% on every trip. A larger end-to-end run through Mosquitto and Postgres (seed 42, 50 vehicles,
200 trips, `npm run sim -- --seed 42 --devices 50 --check`) detected all 200 trips. Its worst trip
was 1.37% off, consistent with the tail shown above.
