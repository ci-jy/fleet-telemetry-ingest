import mqtt from "mqtt";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db, Queryable } from "../src/db/db.js";
import { createPgliteDb } from "../src/db/pglite.js";
import { migrate } from "../src/db/schema.js";
import { Ingestor } from "../src/ingest/ingestor.js";
import { startSubscriber } from "../src/ingest/mqttSubscriber.js";
import { generateFleet, injectFaults } from "../src/sim/fleet.js";
import { publishAll } from "../src/sim/publisher.js";
import { startBroker } from "./helpers/broker.js";

let db: Db;

beforeEach(async () => {
  db = await createPgliteDb();
  await migrate(db);
});
afterEach(async () => {
  await db.close();
});

const tripRows = async (d: Db) =>
  (
    await d.query(
      `SELECT device_id, start_seq, end_seq, start_ts, end_ts, distance_m, duration_s, idle_s, point_count, end_reason
       FROM trips ORDER BY device_id, start_seq`,
    )
  ).rows;
const lateRows = async (d: Db) =>
  (await d.query(`SELECT device_id, seq FROM points WHERE late ORDER BY device_id, seq`)).rows;

/** Wraps a database so that chosen transactions fail, either before or after COMMIT. */
function faultyDb(inner: Db, plan: { failAt: number; afterCommit: boolean }[]): Db & { attempts: number } {
  const wrapped = {
    ...inner,
    attempts: 0,
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const n = wrapped.attempts++;
      const fault = plan.find((p) => p.failAt === n);
      if (fault && !fault.afterCommit) throw new Error("connection reset before commit");
      const out = await inner.transaction(fn);
      if (fault) throw new Error("connection reset while COMMIT was in flight");
      return out;
    },
  };
  return wrapped;
}

async function reference(deliveries: { msg: Parameters<Ingestor["submit"]>[0] }[]) {
  const ref = await createPgliteDb();
  await migrate(ref);
  const ing = new Ingestor(ref, { batchMaxDelayMs: 1e6, batchMaxSize: 200 });
  for (const d of deliveries) ing.submit(d.msg);
  await ing.drain();
  const out = { trips: await tripRows(ref), late: await lateRows(ref) };
  await ref.close();
  return out;
}

describe("resilience", () => {
  it("acknowledges messages only after their batch has committed", async () => {
    const flaky = faultyDb(db, [{ failAt: 0, afterCommit: false }]);
    const ing = new Ingestor(flaky, { batchMaxDelayMs: 1e6, retryDelayMs: 5 });
    const acked: number[] = [];
    const fleet = generateFleet({ seed: 3, devices: 1, tripsPerDevice: 1 });
    for (const m of fleet.messages.slice(0, 20)) ing.submit(m, () => acked.push(m.seq));
    await expect(ing.flush()).rejects.toThrow();
    expect(acked).toEqual([]);
    await ing.flush();
    expect(acked).toHaveLength(20);
    // Invalid messages are acknowledged at once: redelivering them cannot help.
    let invalidAcked = false;
    expect(ing.submitRaw("fleet/x/telemetry", "{", () => (invalidAcked = true))).toBe(false);
    expect(invalidAcked).toBe(true);
  });

  it("rebuilds device state when a failed batch had in fact committed", async () => {
    const fleet = generateFleet({ seed: 11, devices: 4, tripsPerDevice: 3 });
    const { deliveries } = injectFaults(fleet.messages, { seed: 12 });
    // Batches 3 and 7 commit but report failure; batch 5 fails before commit.
    const flaky = faultyDb(db, [
      { failAt: 3, afterCommit: true },
      { failAt: 5, afterCommit: false },
      { failAt: 7, afterCommit: true },
    ]);
    const ing = new Ingestor(flaky, { batchMaxDelayMs: 1e6, batchMaxSize: 200, retryDelayMs: 1 });
    for (const d of deliveries) ing.submit(d.msg);
    for (let i = 0; i < 50 && (ing.stats.pending > 0 || i === 0); i++) await ing.flush().catch(() => undefined);
    await ing.drain();
    expect(ing.stats.batchErrors).toBe(3);
    expect(ing.stats.reloads).toBeGreaterThan(0);

    const ref = await reference(deliveries);
    expect(await tripRows(db)).toEqual(ref.trips);
    expect(await lateRows(db)).toEqual(ref.late);
    expect(ref.trips.length).toBe(fleet.trips.length);
  });

  it("restores reorder buffers after a crash so the result equals an uninterrupted run", async () => {
    const fleet = generateFleet({ seed: 21, devices: 5, tripsPerDevice: 3 });
    const { deliveries } = injectFaults(fleet.messages, { seed: 22 });
    const cuts = [0.2, 0.45, 0.7].map((f) => Math.floor(deliveries.length * f));
    let from = 0;
    for (const cut of [...cuts, deliveries.length]) {
      // Each segment is a process lifetime: recover, ingest, then die without draining buffers.
      const ing = new Ingestor(db, { batchMaxDelayMs: 1e6, batchMaxSize: 200 });
      await ing.recover();
      for (const d of deliveries.slice(from, cut)) ing.submit(d.msg);
      if (cut === deliveries.length) await ing.drain();
      else await ing.flush();
      from = cut;
    }
    const ref = await reference(deliveries);
    expect(await tripRows(db)).toEqual(ref.trips);
    expect(await lateRows(db)).toEqual(ref.late);
  });

  it("graceful shutdown commits queued messages but keeps reorder buffers for the next start", async () => {
    const fleet = generateFleet({ seed: 31, devices: 3, tripsPerDevice: 2 });
    const { deliveries } = injectFaults(fleet.messages, { seed: 32 });
    const half = Math.floor(deliveries.length / 2);
    const first = new Ingestor(db, { batchMaxDelayMs: 1e6, batchMaxSize: 200 });
    let acked = 0;
    for (const d of deliveries.slice(0, half)) first.submit(d.msg, () => acked++);
    const r = await first.shutdown(5_000);
    expect(r).toEqual({ drained: true, pending: 0 });
    expect(acked).toBe(half);
    expect(first.isClosed).toBe(true);
    expect(() => first.submit(deliveries[half]!.msg)).toThrow("closed");

    const second = new Ingestor(db, { batchMaxDelayMs: 1e6, batchMaxSize: 200 });
    await second.recover();
    for (const d of deliveries.slice(half)) second.submit(d.msg);
    await second.drain();
    const ref = await reference(deliveries);
    expect(await tripRows(db)).toEqual(ref.trips);
    expect(await lateRows(db)).toEqual(ref.late);
  });

  it("keeps the retry backoff while new messages keep arriving", async () => {
    let failing = true;
    let attempts = 0;
    const down: Db = {
      ...db,
      transaction: (fn) => {
        attempts++;
        return failing ? Promise.reject(new Error("database down")) : db.transaction(fn);
      },
    };
    const ing = new Ingestor(down, { batchMaxSize: 10, batchMaxDelayMs: 1, retryDelayMs: 200, retryMaxDelayMs: 200 });
    const msgs = generateFleet({ seed: 71, devices: 1, tripsPerDevice: 1 }).messages.slice(0, 100);
    for (const m of msgs.slice(0, 10)) ing.submit(m);
    await new Promise((r) => setTimeout(r, 20));
    expect(attempts).toBe(1);
    // A full batch's worth of new arrivals during the backoff does not trigger another attempt.
    for (const m of msgs.slice(10)) ing.submit(m);
    await new Promise((r) => setTimeout(r, 50));
    expect(attempts).toBe(1);
    failing = false;
    await new Promise((r) => setTimeout(r, 250));
    await ing.drain();
    expect(attempts).toBeLessThanOrEqual(12);
    expect(Number((await db.query<{ n: number }>("SELECT count(*) AS n FROM points")).rows[0]!.n)).toBe(100);
  });

  it("does not replay queued batch triggers back to back after a slow failure", async () => {
    let attempts = 0;
    const slowFail: Db = {
      ...db,
      transaction: async () => {
        attempts++;
        await new Promise((r) => setTimeout(r, 100));
        throw new Error("database shutting down");
      },
    };
    const ing = new Ingestor(slowFail, { batchMaxDelayMs: 2, retryDelayMs: 300, retryMaxDelayMs: 300 });
    const msgs = generateFleet({ seed: 81, devices: 1, tripsPerDevice: 1 }).messages.slice(0, 40);
    // Messages keep arriving while the first (slow) batch is in flight, firing the batch timer often.
    for (const m of msgs) {
      ing.submit(m);
      await new Promise((r) => setTimeout(r, 4));
    }
    await new Promise((r) => setTimeout(r, 150));
    expect(attempts).toBe(1);
    await ing.shutdown(1).catch(() => undefined);
  });

  it("reports saturation at the queue bound and resumes at half capacity", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: Db = {
      ...db,
      transaction: async (fn) => {
        await gate;
        return db.transaction(fn);
      },
    };
    const ing = new Ingestor(slow, { maxPending: 100, batchMaxSize: 60, batchMaxDelayMs: 1 });
    const fleet = generateFleet({ seed: 41, devices: 2, tripsPerDevice: 1 });
    for (const m of fleet.messages.slice(0, 60)) ing.submit(m);
    await new Promise((r) => setTimeout(r, 20));
    // The first 60 are in a batch that is stuck on the database; the next 100 queue up behind it.
    for (const m of fleet.messages.slice(60, 160)) {
      expect(ing.saturated).toBe(false);
      ing.submit(m);
    }
    expect(ing.stats.pending).toBe(100);
    expect(ing.saturated).toBe(true);
    let resumed = false;
    const ready = ing.whenReady().then(() => (resumed = true));
    expect(ing.stats.paused).toBe(true);
    expect(ing.stats.queuePeak).toBe(100);
    release();
    await ready;
    expect(resumed).toBe(true);
    expect(ing.stats.pending).toBeLessThanOrEqual(50);
    expect(ing.stats.paused).toBe(false);
    expect(ing.stats.pauses).toBe(1);
    await ing.drain();
    expect(Number((await db.query<{ n: number }>("SELECT count(*) AS n FROM points")).rows[0]!.n)).toBe(160);
  });

  it("does not count its own outage as device silence in the stale sweep", async () => {
    let now = 1_000_000;
    const ing = new Ingestor(db, { staleFlushMs: 1000, now: () => now });
    // Three messages a second apart, the first one missing: they wait in the reorder buffer.
    const msgs = [2, 3, 4].map((seq) => ({
      deviceId: "q",
      seq,
      ts: 1_767_600_000_000 + seq * 1000,
      lat: 52.5,
      lon: 13.4,
      speedKph: 0,
      ignition: false,
    }));
    for (const m of msgs) ing.submit(m);
    await ing.flush();
    const sweep = () => (ing as unknown as { sweepStale(): void }).sweepStale();
    ing.setSourceConnected(false);
    now += 5000;
    sweep();
    await new Promise((r) => setTimeout(r, 20));
    await ing.flush();
    expect(ing.deviceState(msgs[0]!.deviceId)?.last).toBeNull();
    // Reconnected: quiet time counts again from the reconnect.
    ing.setSourceConnected(true);
    now += 500;
    sweep();
    await new Promise((r) => setTimeout(r, 20));
    await ing.flush();
    expect(ing.deviceState(msgs[0]!.deviceId)?.last).toBeNull();
    now += 600;
    sweep();
    await new Promise((r) => setTimeout(r, 20));
    await ing.flush();
    expect(ing.deviceState(msgs[0]!.deviceId)?.last?.seq).toBe(4);
    await ing.close();
  });

  it("redelivers over MQTT whatever was not committed when the consumer died", async () => {
    const broker = await startBroker();
    try {
      const fleet = generateFleet({ seed: 61, devices: 3, tripsPerDevice: 2 });
      const msgs = fleet.messages;
      // A consumer whose database never commits: it receives messages but must not acknowledge them.
      const stuck = new Ingestor({ ...db, transaction: () => new Promise(() => undefined) }, { batchMaxDelayMs: 1 });
      const sub1 = await startSubscriber(stuck, { url: broker.url, topic: "fleet/+/telemetry", clientId: "redeliver" });
      const pub = await mqtt.connectAsync(broker.url, { clientId: "redeliver-pub" });
      await publishAll(pub, msgs);
      const deadline = Date.now() + 10_000;
      while (stuck.stats.received < 50 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(stuck.stats.received).toBeGreaterThan(0);
      sub1.end(true); // crash: no acknowledgements were ever sent
      await new Promise((r) => setTimeout(r, 100));

      const ing = new Ingestor(db, { batchMaxDelayMs: 5 });
      const sub2 = await startSubscriber(ing, { url: broker.url, topic: "fleet/+/telemetry", clientId: "redeliver" });
      const deadline2 = Date.now() + 20_000;
      const stored = async () => Number((await db.query<{ n: number }>("SELECT count(*) AS n FROM points")).rows[0]!.n);
      while ((await stored()) < msgs.length && Date.now() < deadline2) await new Promise((r) => setTimeout(r, 50));
      expect(await stored()).toBe(msgs.length);
      expect(sub2.subscriberStats.connects).toBe(1);
      await pub.endAsync();
      await sub2.endAsync();
      await ing.close();
    } finally {
      await broker.close();
    }
  });
});
