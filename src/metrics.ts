import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { CoordinatorStats } from "./cluster/coordinator.js";
import type { CommittedPoint, IngestStats } from "./ingest/ingestor.js";

/**
 * Prometheus metrics of one ingest process, served on GET /metrics.
 *
 * Counters mirror the ingestor's and coordinator's running totals (read at scrape time); the
 * publish-to-commit histogram is fed by the ingestor after every commit.
 */
export interface Metrics {
  registry: Registry;
  /** Ingestor `onCommit` hook. */
  observeCommit: (points: readonly CommittedPoint[], committedAt: number) => void;
}

export function createMetrics(sources: {
  ingest: () => IngestStats;
  coordinator?: () => CoordinatorStats;
}): Metrics {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: "fleet_" });

  // A counter that follows a monotonically increasing total kept elsewhere.
  const mirror = (name: string, help: string, labelNames: string[], read: () => Record<string, number>) => {
    const last = new Map<string, number>();
    return new Counter({
      name,
      help,
      labelNames,
      registers: [registry],
      collect() {
        for (const [label, total] of Object.entries(read())) {
          const prev = last.get(label) ?? 0;
          if (total > prev) {
            if (labelNames.length > 0) this.inc({ [labelNames[0]!]: label }, total - prev);
            else this.inc(total - prev);
          }
          last.set(label, total);
        }
      },
    });
  };
  const s = sources.ingest;
  mirror("fleet_ingest_messages_total", "Messages received from MQTT, by outcome.", ["outcome"], () => {
    const st = s();
    return { stored: st.stored, duplicate: st.duplicates, invalid: st.invalid, late: st.late };
  });
  mirror("fleet_ingest_received_total", "Messages received from MQTT (every outcome).", [], () => ({ all: s().received }));
  mirror("fleet_ingest_dedupe_rejections_total", "Redelivered or duplicated messages dropped by the idempotency key.", [], () => ({
    all: s().duplicates,
  }));
  mirror("fleet_ingest_batches_total", "Committed batches.", [], () => ({ all: s().batches }));
  mirror("fleet_ingest_batch_errors_total", "Failed batch transactions (retried).", [], () => ({ all: s().batchErrors }));
  mirror("fleet_ingest_fenced_batches_total", "Batches refused because a partition lease was lost.", [], () => ({ all: s().fenced }));
  mirror("fleet_ingest_trips_closed_total", "Trips closed by the state machine.", [], () => ({ all: s().tripsClosed }));

  const gauge = (name: string, help: string, read: () => number) =>
    new Gauge({
      name,
      help,
      registers: [registry],
      collect() {
        this.set(read());
      },
    });
  gauge("fleet_ingest_queue_depth", "Messages waiting in memory for a batch.", () => s().pending);
  gauge("fleet_ingest_queue_capacity", "Bound of the in-memory queue.", () => s().queueCapacity);
  gauge("fleet_ingest_paused", "1 while the consumer is paused because the queue is full.", () => (s().paused ? 1 : 0));
  gauge("fleet_ingest_reorder_buffered", "Messages held in reorder buffers.", () => s().buffered);
  gauge("fleet_ingest_devices", "Devices with in-memory state on this pod.", () => s().devices);
  gauge("fleet_ingest_source_connected", "1 while every MQTT session of this pod is connected.", () => (s().sourceConnected ? 1 : 0));
  gauge("fleet_ingest_consecutive_failures", "Failed batches in a row (0 when the database is healthy).", () => s().consecutiveFailures);

  const latency = new Histogram({
    name: "fleet_ingest_publish_to_commit_seconds",
    help: "Time from the publisher's send (or arrival, if unstamped) to the commit of the message.",
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
  });

  const c = sources.coordinator;
  if (c) {
    gauge("fleet_partitions_owned", "Partitions whose lease this pod holds.", () => c().owned);
    gauge("fleet_partitions_unowned", "Partitions without a live lease (as seen by this pod).", () => c().unowned);
    gauge("fleet_partition_unowned_seconds", "Longest time any partition has been without an owner.", () => c().maxUnownedSeconds);
    gauge("fleet_cluster_members", "Live ingest pods in the membership table.", () => c().members);
    mirror("fleet_lease_acquisitions_total", "Partition leases acquired.", [], () => ({ all: c().acquisitions }));
    mirror("fleet_lease_releases_total", "Partition leases handed back gracefully.", [], () => ({ all: c().releases }));
    mirror("fleet_lease_losses_total", "Partition leases lost (expired, fenced or failed to renew).", [], () => ({ all: c().losses }));
    mirror("fleet_partition_devices_rebuilt_total", "Devices rebuilt from the database after gaining a partition.", [], () => ({
      all: c().devicesRebuilt,
    }));
  }

  return {
    registry,
    observeCommit(points, committedAt) {
      for (const p of points) latency.observe(Math.max(0, committedAt - (p.publishedAt ?? p.receivedAt)) / 1000);
    },
  };
}
