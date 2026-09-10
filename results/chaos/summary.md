| Scenario | Runs | Passed | Lost | Duplicate rows | Trips identical | Median recovery s | Max recovery s | Median catch-up s | Max peak queue |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| sigkill-ingest | 5 | 5 | 0 | 0 | all | 0.38 | 0.39 | 0.50 | 2000 |
| sigterm-ingest | 5 | 5 | 0 | 0 | all | 0.35 | 0.39 | 0.42 | 2000 |
| mosquitto-restart | 5 | 5 | 0 | 0 | all | 0.38 | 0.47 | 0.38 | 1375 |
| postgres-restart | 5 | 5 | 0 | 0 | all | 0.17 | 0.18 | 0.58 | 2000 |
| network-latency | 5 | 5 | 0 | 0 | all | 0.07 | 0.09 | 0.29 | 2000 |
| db-partition | 5 | 5 | 0 | 0 | all | 0.52 | 0.57 | 0.76 | 2035 |

| Scenario | Seed | Messages delivered | Unique | Lost | Duplicate rows | Trips (match fault-free) | Downtime s | Recovery s | Catch-up s | Peak queue | Paused | Failed batches | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | --- |
| sigkill-ingest | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 2.26 | 0.35 | 0.50 | 2000 / 2000 | yes | 0 | pass |
| sigkill-ingest | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 2.27 | 0.38 | 0.48 | 2000 / 2000 | yes | 0 | pass |
| sigkill-ingest | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 2.25 | 0.38 | 0.53 | 2000 / 2000 | yes | 0 | pass |
| sigkill-ingest | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 2.28 | 0.34 | 0.50 | 2000 / 2000 | yes | 0 | pass |
| sigkill-ingest | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 2.28 | 0.39 | 0.54 | 2000 / 2000 | yes | 0 | pass |
| sigterm-ingest | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 1.38 | 0.32 | 0.42 | 1632 / 2000 | no | 0 | pass |
| sigterm-ingest | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 1.42 | 0.37 | 0.42 | 1407 / 2000 | no | 0 | pass |
| sigterm-ingest | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 1.47 | 0.39 | 0.49 | 1591 / 2000 | no | 0 | pass |
| sigterm-ingest | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 1.48 | 0.34 | 0.45 | 1511 / 2000 | no | 0 | pass |
| sigterm-ingest | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 1.39 | 0.35 | 0.40 | 2000 / 2000 | yes | 0 | pass |
| mosquitto-restart | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 0.68 | 0.38 | 0.38 | 1356 / 2000 | no | 0 | pass |
| mosquitto-restart | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 0.73 | 0.35 | 0.35 | 1375 / 2000 | no | 0 | pass |
| mosquitto-restart | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 0.67 | 0.39 | 0.39 | 1353 / 2000 | no | 0 | pass |
| mosquitto-restart | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 0.69 | 0.47 | 0.47 | 1362 / 2000 | no | 0 | pass |
| mosquitto-restart | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 0.71 | 0.36 | 0.36 | 1346 / 2000 | no | 0 | pass |
| postgres-restart | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 2.14 | 0.18 | 1.25 | 2000 / 2000 | yes | 4 | pass |
| postgres-restart | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 1.13 | 0.18 | 0.58 | 2000 / 2000 | yes | 3 | pass |
| postgres-restart | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 1.18 | 0.16 | 0.57 | 2000 / 2000 | yes | 3 | pass |
| postgres-restart | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 1.16 | 0.17 | 0.58 | 2000 / 2000 | yes | 3 | pass |
| postgres-restart | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 1.14 | 0.17 | 0.57 | 2000 / 2000 | yes | 3 | pass |
| network-latency | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 5.01 | 0.08 | 0.29 | 2000 / 2000 | yes | 0 | pass |
| network-latency | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 5.01 | 0.07 | 0.27 | 2000 / 2000 | yes | 0 | pass |
| network-latency | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 5.01 | 0.03 | 0.29 | 2000 / 2000 | yes | 0 | pass |
| network-latency | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 5.01 | 0.09 | 0.29 | 2000 / 2000 | yes | 0 | pass |
| network-latency | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 5.01 | 0.07 | 0.23 | 2000 / 2000 | yes | 0 | pass |
| db-partition | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 6.01 | 0.51 | 0.76 | 2033 / 2000 | yes | 2 | pass |
| db-partition | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 6.01 | 0.57 | 0.77 | 2035 / 2000 | yes | 2 | pass |
| db-partition | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 6.01 | 0.53 | – | 2021 / 2000 | yes | 2 | pass |
| db-partition | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 6.01 | 0.51 | 0.77 | 2027 / 2000 | yes | 2 | pass |
| db-partition | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 6.01 | 0.52 | 0.72 | 2029 / 2000 | yes | 2 | pass |
