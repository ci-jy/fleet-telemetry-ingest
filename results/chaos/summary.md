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
