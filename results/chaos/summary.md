| Scenario | Runs | Passed | Lost | Duplicate rows | Trips identical | Median recovery s | Max recovery s | Median catch-up s | Max peak queue |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| sigkill-ingest | 5 | 5 | 0 | 0 | all | 0.38 | 0.43 | 0.54 | 2000 |
| sigterm-ingest | 5 | 5 | 0 | 0 | all | 0.38 | 0.41 | 0.43 | 2000 |
| mosquitto-restart | 5 | 5 | 0 | 0 | all | 0.40 | 0.50 | 0.40 | 1378 |
| postgres-restart | 5 | 5 | 0 | 0 | all | 0.15 | 0.15 | 0.61 | 2000 |
| network-latency | 5 | 5 | 0 | 0 | all | 0.05 | 0.07 | 0.29 | 2000 |
| db-partition | 5 | 5 | 0 | 0 | all | 0.51 | 0.54 | 0.72 | 2036 |

| Scenario | Seed | Messages delivered | Unique | Lost | Duplicate rows | Trips (match fault-free) | Downtime s | Recovery s | Catch-up s | Peak queue | Paused | Failed batches | Result |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: | --- |
| sigkill-ingest | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 2.28 | 0.39 | 0.54 | 2000 / 2000 | yes | 0 | pass |
| sigkill-ingest | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 2.29 | 0.37 | 0.52 | 2000 / 2000 | yes | 0 | pass |
| sigkill-ingest | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 2.26 | 0.36 | 0.51 | 2000 / 2000 | yes | 0 | pass |
| sigkill-ingest | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 2.26 | 0.38 | 0.58 | 2000 / 2000 | yes | 0 | pass |
| sigkill-ingest | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 2.27 | 0.43 | 0.59 | 2000 / 2000 | yes | 0 | pass |
| sigterm-ingest | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 1.38 | 0.37 | 0.42 | 1568 / 2000 | no | 0 | pass |
| sigterm-ingest | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 1.41 | 0.38 | 0.43 | 2000 / 2000 | yes | 0 | pass |
| sigterm-ingest | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 1.44 | 0.37 | 0.42 | 2000 / 2000 | yes | 0 | pass |
| sigterm-ingest | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 1.44 | 0.38 | 0.43 | 2000 / 2000 | yes | 0 | pass |
| sigterm-ingest | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 1.39 | 0.41 | 0.46 | 2000 / 2000 | yes | 0 | pass |
| mosquitto-restart | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 0.67 | 0.44 | 0.44 | 1378 / 2000 | no | 0 | pass |
| mosquitto-restart | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 0.68 | 0.38 | 0.38 | 832 / 2000 | no | 0 | pass |
| mosquitto-restart | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 0.66 | 0.40 | 0.40 | 1358 / 2000 | no | 0 | pass |
| mosquitto-restart | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 0.66 | 0.50 | 0.50 | 1345 / 2000 | no | 0 | pass |
| mosquitto-restart | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 0.68 | 0.40 | 0.40 | 1353 / 2000 | no | 0 | pass |
| postgres-restart | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 2.11 | 0.14 | 1.27 | 2000 / 2000 | yes | 4 | pass |
| postgres-restart | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 1.18 | 0.13 | 0.54 | 2000 / 2000 | yes | 3 | pass |
| postgres-restart | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 1.13 | 0.15 | 0.61 | 2000 / 2000 | yes | 3 | pass |
| postgres-restart | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 1.20 | 0.15 | 0.56 | 2000 / 2000 | yes | 3 | pass |
| postgres-restart | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 1.14 | 0.15 | 0.61 | 2000 / 2000 | yes | 3 | pass |
| network-latency | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 5.02 | 0.04 | 0.29 | 2000 / 2000 | yes | 0 | pass |
| network-latency | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 5.01 | 0.07 | 0.28 | 2000 / 2000 | yes | 0 | pass |
| network-latency | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 5.01 | 0.04 | 0.30 | 2000 / 2000 | yes | 0 | pass |
| network-latency | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 5.01 | 0.05 | 0.30 | 2000 / 2000 | yes | 0 | pass |
| network-latency | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 5.01 | 0.07 | – | 2000 / 2000 | yes | 0 | pass |
| db-partition | 1 | 7338 | 7007 | 0 | 0 | 24 (yes) | 6.00 | 0.52 | 0.78 | 2021 / 2000 | yes | 2 | pass |
| db-partition | 2 | 7128 | 6774 | 0 | 0 | 24 (yes) | 6.00 | 0.51 | 0.71 | 2021 / 2000 | yes | 2 | pass |
| db-partition | 3 | 7284 | 6941 | 0 | 0 | 24 (yes) | 6.00 | 0.54 | 0.74 | 2030 / 2000 | yes | 2 | pass |
| db-partition | 4 | 7440 | 7103 | 0 | 0 | 24 (yes) | 6.01 | 0.51 | – | 2031 / 2000 | yes | 2 | pass |
| db-partition | 5 | 6313 | 5999 | 0 | 0 | 24 (yes) | 6.01 | 0.47 | 0.72 | 2036 / 2000 | yes | 2 | pass |
