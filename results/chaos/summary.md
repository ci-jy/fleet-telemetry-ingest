| Scenario | Runs | Passed | Lost | Duplicate rows | Trips identical | Median recovery s | Max recovery s | Median catch-up s | Max peak queue |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| sigkill-ingest | 5 | 5 | 0 | 0 | all | 0.36 | 0.52 | 0.56 | 2000 |
| sigterm-ingest | 5 | 5 | 0 | 0 | all | 0.42 | 0.50 | 0.51 | 2000 |
| mosquitto-restart | 5 | 5 | 0 | 0 | all | 0.39 | 0.41 | 0.39 | 1377 |
| postgres-restart | 5 | 5 | 0 | 0 | all | 0.16 | 0.19 | 0.60 | 2000 |
| network-latency | 5 | 5 | 0 | 0 | all | 0.04 | 0.07 | 0.25 | 2000 |
| db-partition | 5 | 5 | 0 | 0 | all | 0.49 | 0.52 | 0.77 | 2033 |

| Scenario | Seed | Messages delivered | Unique | Lost | Duplicate rows | Trips (match fault-free) | Downtime s | Recovery s | Catch-up s | Peak queue | Paused | Failed batches | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | --- |
| sigkill-ingest | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 2.25 | 0.41 | 0.56 | 2000 / 2000 | yes | 0 | pass |
| sigkill-ingest | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 2.24 | 0.34 | 0.49 | 2000 / 2000 | yes | 0 | pass |
| sigkill-ingest | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 2.17 | 0.52 | 0.67 | 2000 / 2000 | yes | 0 | pass |
| sigkill-ingest | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 2.23 | 0.34 | 0.49 | 2000 / 2000 | yes | 0 | pass |
| sigkill-ingest | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 2.25 | 0.36 | 0.56 | 2000 / 2000 | yes | 0 | pass |
| sigterm-ingest | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 1.41 | 0.37 | 0.42 | 2000 / 2000 | yes | 0 | pass |
| sigterm-ingest | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 1.37 | 0.46 | 0.51 | 2000 / 2000 | yes | 0 | pass |
| sigterm-ingest | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 1.35 | 0.42 | 0.52 | 2000 / 2000 | yes | 0 | pass |
| sigterm-ingest | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 1.35 | 0.50 | 0.55 | 1618 / 2000 | no | 0 | pass |
| sigterm-ingest | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 1.42 | 0.42 | 0.47 | 2000 / 2000 | yes | 0 | pass |
| mosquitto-restart | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 0.70 | 0.38 | 0.38 | 1377 / 2000 | no | 0 | pass |
| mosquitto-restart | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 0.68 | 0.39 | 0.39 | 996 / 2000 | no | 0 | pass |
| mosquitto-restart | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 0.65 | 0.41 | 0.41 | 1356 / 2000 | no | 0 | pass |
| mosquitto-restart | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 0.69 | 0.37 | 0.37 | 1367 / 2000 | no | 0 | pass |
| mosquitto-restart | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 0.69 | 0.39 | 0.39 | 1355 / 2000 | no | 0 | pass |
| postgres-restart | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 2.18 | 0.19 | 1.27 | 2000 / 2000 | yes | 4 | pass |
| postgres-restart | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 1.17 | 0.15 | 0.60 | 2000 / 2000 | yes | 3 | pass |
| postgres-restart | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 1.18 | 0.16 | 0.57 | 2000 / 2000 | yes | 3 | pass |
| postgres-restart | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 1.16 | 0.17 | 0.58 | 2000 / 2000 | yes | 3 | pass |
| postgres-restart | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 1.11 | 0.14 | 0.60 | 2000 / 2000 | yes | 3 | pass |
| network-latency | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 5.01 | 0.04 | 0.30 | 2000 / 2000 | yes | 0 | pass |
| network-latency | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 5.01 | 0.04 | 0.24 | 2000 / 2000 | yes | 0 | pass |
| network-latency | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 5.01 | 0.03 | 0.29 | 2000 / 2000 | yes | 0 | pass |
| network-latency | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 5.01 | 0.04 | 0.25 | 2000 / 2000 | yes | 0 | pass |
| network-latency | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 5.01 | 0.07 | 0.22 | 2000 / 2000 | yes | 0 | pass |
| db-partition | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 6.02 | 0.49 | 0.75 | 2020 / 2000 | yes | 2 | pass |
| db-partition | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 6.01 | 0.48 | 0.78 | 2031 / 2000 | yes | 2 | pass |
| db-partition | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 6.01 | 0.52 | 0.77 | 2029 / 2000 | yes | 2 | pass |
| db-partition | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 6.01 | 0.49 | 0.75 | 2030 / 2000 | yes | 2 | pass |
| db-partition | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 6.01 | 0.50 | 0.77 | 2033 / 2000 | yes | 2 | pass |
