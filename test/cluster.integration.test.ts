import { mkdirSync, writeFileSync } from "node:fs";
import mqtt from "mqtt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkInvariants, diffTrips, type TripRow } from "../src/chaos/invariants.js";
import { PartitionCoordinator } from "../src/cluster/coordinator.js";
import { LeaseStore, ownerId } from "../src/cluster/leases.js";
import type { Db } from "../src/db/db.js";
import { createPgliteDb } from "../src/db/pglite.js";
import { migrate } from "../src/db/schema.js";
import { Ingestor } from "../src/ingest/ingestor.js";
import { generateFleet, injectFaults } from "../src/sim/fleet.js";
import { publishAll } from "../src/sim/publisher.js";
import { startBroker } from "./helpers/broker.js";

/**
 * Several ingest "pods" (ingestor + partition coordinator each) share one Postgres and one broker
 * in this process. The fleet is published while pods are added, crashed, restarted and stopped;
 * afterwards every delivered message must be stored exactly once and the trips must equal those
 * of a single uninterrupted ingestor fed the same deliveries.
 */
const PARTITIONS = 8;
const TTL_MS = 800;
const RENEW_MS = 150;
// The fleet is replayed as fast as possible, so a few hundred milliseconds of handoff span
// minutes of event time. Messages redelivered after a handoff then arrive behind newer ones by more
// than the default 30 s window and are (correctly) flagged late, which a single process fed the
// same order would not do. A window wider than the replay keeps the comparison about state handoff.
const REORDER = { windowMs: 3_600_000, maxBuffered: 100_000 };

let broker: Awaited<ReturnType<typeof startBroker>>;
let db: Db;
let refDb: Db;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  broker = await startBroker();
  db = await createPgliteDb();
  refDb = await createPgliteDb();
  await migrate(db);
  await migrate(refDb);
});
afterAll(async () => {
  await broker.close();
  await db.close();
  await refDb.close();
});

interface Pod {
  name: string;
  ingestor: Ingestor;
  coordinator: PartitionCoordinator;
}

let incarnation = 0;
async function startPod(name: string): Promise<Pod> {
  const store = new LeaseStore(db, ownerId(name, String(++incarnation)), name, TTL_MS);
  let coordinator: PartitionCoordinator | null = null;
  const ingestor = new Ingestor(db, {
    partitions: PARTITIONS,
    batchMaxSize: 500,
    batchMaxDelayMs: 10,
    reorder: REORDER,
    fence: (tx, ids) => coordinator!.fence(tx, ids),
    onFenced: (err) => coordinator!.onFenced(err),
  });
  coordinator = new PartitionCoordinator(ingestor, store, {
    partitions: PARTITIONS,
    leaseTtlMs: TTL_MS,
    renewEveryMs: RENEW_MS,
    clientIdPrefix: "fleet-ingest",
    mqttUrl: broker.url,
    sessionExpiryS: 3600,
    protocolVersion: 4, // the in-process test broker speaks MQTT 3.1.1
    reconnectMinMs: 50,
    reconnectMaxMs: 500,
    log: () => undefined,
  });
  ingestor.start();
  await coordinator.start();
  return { name, ingestor, coordinator };
}

/** SIGKILL: nothing is drained, acknowledged or released. */
function crash(pod: Pod): void {
  pod.coordinator.halt();
  pod.ingestor.dropWhere(() => true);
  void pod.ingestor.shutdown(0);
}

/** SIGTERM: commit and acknowledge what is queued, then hand the partitions back. */
async function stopGracefully(pod: Pod): Promise<void> {
  await pod.ingestor.shutdown(5_000);
  await pod.coordinator.stop();
}

async function ownership(): Promise<{ owned: number; owners: Set<string> }> {
  const { rows } = await db.query<{ owner: string | null; live: boolean }>(
    `SELECT owner, (owner IS NOT NULL AND expires_at > now()) AS live FROM partition_leases`,
  );
  const live = rows.filter((r) => r.live);
  return { owned: live.length, owners: new Set(live.map((r) => r.owner!.split("~")[0]!)) };
}

async function waitFor(what: string, cond: () => Promise<boolean> | boolean, timeoutMs = 20_000): Promise<number> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
  return Date.now() - start;
}

const balanced = (pods: Pod[]) => async () => {
  const o = await ownership();
  const counts = pods.map((p) => p.coordinator.stats.owned);
  return o.owned === PARTITIONS && counts.every((c) => c > 0 && c <= Math.ceil(PARTITIONS / pods.length));
};

const tripRows = async (d: Db) =>
  (
    await d.query<TripRow>(
      `SELECT device_id, start_seq, end_seq, start_ts::text AS start_ts, end_ts::text AS end_ts, distance_m,
              duration_s, idle_s, point_count, max_speed_kph, end_reason FROM trips ORDER BY device_id, start_seq`,
    )
  ).rows;

describe("partitioned ingestion across pod crashes and rebalancing", () => {
  it("stores every message exactly once and produces the single-process trips", async () => {
    const fleet = generateFleet({ seed: 99, devices: 24, tripsPerDevice: 2 });
    const { deliveries } = injectFaults(fleet.messages, { seed: 100 });
    const msgs = deliveries.map((d) => d.msg);
    const chunks = 6;
    const size = Math.ceil(msgs.length / chunks);
    const part = (i: number) => msgs.slice(i * size, (i + 1) * size);

    const pub = await mqtt.connectAsync(broker.url, { clientId: "cluster-test-pub" });
    const publish = (i: number) => publishAll(pub, part(i), { partitions: PARTITIONS });
    const events: { step: string; ms: number }[] = [];
    const time = async (step: string, fn: () => Promise<unknown>) => {
      const t0 = Date.now();
      await fn();
      events.push({ step, ms: Date.now() - t0 });
    };

    // One pod owns everything.
    const pod0 = await startPod("ingest-0");
    expect(pod0.coordinator.stats.owned).toBe(PARTITIONS);
    await publish(0);

    // Scale 1 -> 3: the first pod hands partitions over until each holds its share.
    const pod1 = await startPod("ingest-1");
    const pod2 = await startPod("ingest-2");
    let live = [pod0, pod1, pod2];
    await time("scale 1->3 rebalanced", () => waitFor("rebalance to 3 pods", balanced(live)));
    await publish(1);

    // ingest-1 is killed and its StatefulSet replacement (same name) takes its leases at once.
    crash(pod1);
    const pod1b = await startPod("ingest-1");
    live = [pod0, pod1b, pod2];
    await time("pod kill + restart: all partitions owned", () => waitFor("takeover by restarted pod", balanced(live)));
    await publish(2);

    // ingest-2 is killed for good: its leases expire and the survivors take them over.
    crash(pod2);
    live = [pod0, pod1b];
    await time("pod kill, no restart: leases expired and taken over", () =>
      waitFor("takeover after expiry", balanced(live)),
    );
    await publish(3);

    // Scale down: ingest-0 stops gracefully and releases its partitions without waiting for expiry.
    await time("graceful stop: partitions handed over", async () => {
      await stopGracefully(pod0);
      live = [pod1b];
      await waitFor("takeover after release", balanced(live), TTL_MS * 2);
    });
    await publish(4);

    // Scale up again.
    const pod3 = await startPod("ingest-3");
    live = [pod1b, pod3];
    await time("scale 1->2 rebalanced", () => waitFor("rebalance to 2 pods", balanced(live)));
    await publish(5);
    await pub.endAsync();

    const expected = new Set(msgs.map((m) => `${m.deviceId}#${m.seq}`)).size;
    const stored = async () => Number((await db.query<{ n: number }>("SELECT count(*) AS n FROM points")).rows[0]!.n);
    await waitFor("every message stored", async () => (await stored()) >= expected, 30_000);
    await sleep(300);
    for (const p of live) await p.ingestor.drain();

    // Reference: one uninterrupted ingestor, same deliveries, same order.
    const ref = new Ingestor(refDb, { batchMaxSize: 500, reorder: REORDER });
    for (const m of msgs) ref.submit(m);
    await ref.close();

    const run = {
      points: (await db.query<{ device_id: string; seq: number }>("SELECT device_id, seq FROM points")).rows,
      latePoints: (await db.query<{ device_id: string; seq: number }>("SELECT device_id, seq FROM points WHERE late")).rows,
      trips: await tripRows(db),
      idleSegments: [],
    };
    const report = checkInvariants(msgs, run);
    const tripDiffs = diffTrips(await tripRows(refDb), run.trips);
    const stats = [pod0, pod1, pod2, pod1b, pod3].map((p) => ({ pod: p.name, ...p.coordinator.stats, fenced: p.ingestor.stats.fenced }));
    const handoffs = stats.reduce((n, s) => n + s.acquisitions, 0);

    mkdirSync("results", { recursive: true });
    writeFileSync(
      "results/cluster-chaos.json",
      JSON.stringify(
        {
          partitions: PARTITIONS,
          devices: 24,
          sent: msgs.length,
          distinct: expected,
          stored: report.stored,
          lost: report.lost,
          duplicated: report.duplicates,
          phantom: report.phantom,
          trips: run.trips.length,
          latePoints: run.latePoints.length,
          referenceLatePoints: Number((await refDb.query<{ n: number }>("SELECT count(*) AS n FROM points WHERE late")).rows[0]!.n),
          tripDifferencesFromSingleProcess: tripDiffs.length,
          leaseAcquisitions: handoffs,
          events,
          pods: stats,
        },
        null,
        2,
      ) + "\n",
    );

    expect(report.lost, report.examples.join(", ")).toBe(0);
    expect(report.duplicates).toBe(0);
    expect(report.phantom).toBe(0);
    expect(report.duplicateTrips).toBe(0);
    expect(report.stored).toBe(expected);
    expect(tripDiffs).toEqual([]);
    expect(run.trips.length).toBe(fleet.trips.length);
    expect(handoffs).toBeGreaterThan(PARTITIONS * 2);

    for (const p of live) await stopGracefully(p);
  }, 120_000);
});
