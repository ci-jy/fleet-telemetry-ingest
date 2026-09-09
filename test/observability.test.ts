import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildApi } from "../src/api/server.js";
import { createPgliteDb } from "../src/db/pglite.js";
import { migrate } from "../src/db/schema.js";
import { Ingestor } from "../src/ingest/ingestor.js";
import { createMetrics } from "../src/metrics.js";
import type { CoordinatorStats } from "../src/cluster/coordinator.js";

const coordinatorStats: CoordinatorStats = {
  owned: 5,
  members: 3,
  unowned: 1,
  maxUnownedSeconds: 4.5,
  acquisitions: 7,
  releases: 2,
  losses: 1,
  devicesRebuilt: 30,
  tickErrors: 0,
};

async function scrape(): Promise<string> {
  const db = await createPgliteDb();
  await migrate(db);
  let ingestor2: Ingestor | null = null;
  const metrics = createMetrics({ ingest: () => ingestor2!.stats, coordinator: () => coordinatorStats });
  ingestor2 = new Ingestor(db, { onCommit: metrics.observeCommit });
  const msg = { deviceId: "veh-1", seq: 1, ts: 1767600000000, lat: 52.5, lon: 13.4, speedKph: 0, ignition: false };
  ingestor2.submitRaw("fleet/veh-1/telemetry", JSON.stringify(msg), undefined, Date.now() - 40);
  ingestor2.submitRaw("fleet/veh-1/telemetry", JSON.stringify(msg));
  await ingestor2.flush();
  const api = await buildApi({ db, stats: () => ingestor2.stats, metrics: metrics.registry });
  const res = await api.inject({ method: "GET", url: "/metrics" });
  expect(res.statusCode).toBe(200);
  expect(res.headers["content-type"]).toContain("text/plain");
  await api.close();
  await ingestor2.close();
  await db.close();
  return res.body;
}

/** Metric names referenced by a PromQL expression (fleet_* and up). */
const referenced = (expr: string): string[] =>
  [...expr.matchAll(/\b(fleet_[a-z_]+|up)\b/g)].map((m) => m[1]!.replace(/_(bucket|sum|count)$/, ""));

describe("Prometheus metrics", () => {
  it("serves ingest, latency and partition metrics on /metrics", async () => {
    const body = await scrape();
    expect(body).toMatch(/fleet_ingest_messages_total\{outcome="stored"\} 1/);
    expect(body).toMatch(/fleet_ingest_messages_total\{outcome="duplicate"\} 1/);
    expect(body).toMatch(/fleet_ingest_dedupe_rejections_total 1/);
    expect(body).toMatch(/fleet_ingest_publish_to_commit_seconds_count 2/);
    // The stamped message waited at least 40 ms since its publish.
    expect(body).toMatch(/fleet_ingest_publish_to_commit_seconds_bucket\{le="0.025"\} 1/);
    expect(body).toMatch(/fleet_ingest_queue_depth 0/);
    expect(body).toMatch(/fleet_partitions_owned 5/);
    expect(body).toMatch(/fleet_partition_unowned_seconds 4.5/);
    expect(body).toMatch(/fleet_lease_acquisitions_total 7/);
    expect(body).toMatch(/fleet_lease_losses_total 1/);
  });

  it("every metric used by the alert rules and the dashboard exists", async () => {
    const body = await scrape();
    const exported = new Set([...body.matchAll(/^# TYPE (\S+)/gm)].map((m) => m[1]!));
    exported.add("up");
    const rules = readFileSync("deploy/prometheus/rules.yaml", "utf8");
    const dashboard = JSON.parse(readFileSync("deploy/grafana/fleet-ingest.json", "utf8")) as {
      uid: string;
      panels: { title: string; targets: { expr: string }[]; gridPos: unknown }[];
    };
    expect(dashboard.uid).toBe("fleet-ingest");
    expect(dashboard.panels.length).toBeGreaterThanOrEqual(8);
    const exprs = [...rules.matchAll(/expr: (.+)/g)].map((m) => m[1]!).concat(rules.match(/sum\(rate\([a-z_]+\[5m\]\)\)/g) ?? []);
    for (const p of dashboard.panels) {
      expect(p.gridPos, p.title).toBeDefined();
      expect(p.targets.length, p.title).toBeGreaterThan(0);
      exprs.push(...p.targets.map((t) => t.expr));
    }
    const missing = exprs.flatMap(referenced).filter((m) => !exported.has(m));
    expect(missing).toEqual([]);
  });
});
