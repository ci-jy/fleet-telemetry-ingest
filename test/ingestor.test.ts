import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db, Queryable } from "../src/db/db.js";
import { createPgliteDb } from "../src/db/pglite.js";
import { migrate } from "../src/db/schema.js";
import type { Telemetry } from "../src/domain/telemetry.js";
import { Ingestor } from "../src/ingest/ingestor.js";
import { generateFleet, injectFaults } from "../src/sim/fleet.js";

const T0 = Date.UTC(2026, 0, 1, 8, 0, 0);
let db: Db;

beforeEach(async () => {
  db = await createPgliteDb();
  await migrate(db);
});
afterEach(async () => {
  await db.close();
});

function trip(deviceId: string, startSeq: number, startTs: number): Telemetry[] {
  const out: Telemetry[] = [];
  let seq = startSeq;
  let ts = startTs;
  let lon = 13.4;
  const add = (speedKph: number, ignition: boolean) => {
    ts += 5000;
    if (speedKph > 0) lon += 0.0007;
    out.push({ deviceId, seq: seq++, ts, lat: 52.5, lon, speedKph, ignition });
  };
  add(0, false);
  for (let i = 0; i < 10; i++) add(40, true);
  for (let i = 0; i < 15; i++) add(0, true); // 75 s idle
  for (let i = 0; i < 10; i++) add(40, true);
  add(0, false);
  for (let i = 0; i < 3; i++) add(0, false);
  return out;
}

const count = async (sql: string, params: unknown[] = []) =>
  Number((await db.query<{ n: number }>(sql, params)).rows[0]!.n);

describe("Ingestor", () => {
  it("stores points, a trip and its idle segment in Postgres", async () => {
    const ing = new Ingestor(db);
    for (const m of trip("a", 1, T0)) ing.submit(m);
    await ing.drain();
    expect(await count("SELECT count(*) AS n FROM points")).toBe(40);
    const trips = (await db.query<{ distance_m: number; idle_s: number; end_reason: string; id: number }>("SELECT * FROM trips")).rows;
    expect(trips).toHaveLength(1);
    expect(trips[0]!.end_reason).toBe("ignition_off");
    expect(trips[0]!.idle_s).toBe(75);
    expect(await count("SELECT count(*) AS n FROM idle_segments WHERE trip_id = $1", [trips[0]!.id])).toBe(1);
    const dev = (await db.query<{ state: string }>("SELECT state FROM devices WHERE device_id = 'a'")).rows[0]!;
    expect(dev.state).toBe("parked");
  });

  it("deduplicates by (device, seq) within a batch, across batches and across restarts", async () => {
    const msgs = trip("a", 1, T0);
    const ing = new Ingestor(db);
    for (const m of msgs) ing.submit(m);
    for (const m of msgs.slice(0, 5)) ing.submit({ ...m }); // same batch
    await ing.drain();
    for (const m of msgs) ing.submit({ ...m }); // later batch
    await ing.drain();
    expect(ing.stats.duplicates).toBe(5 + msgs.length);
    expect(ing.stats.stored).toBe(msgs.length);

    const restarted = new Ingestor(db);
    await restarted.recover();
    for (const m of msgs) restarted.submit({ ...m });
    await restarted.drain();
    expect(restarted.stats.duplicates).toBe(msgs.length);
    expect(await count("SELECT count(*) AS n FROM points")).toBe(msgs.length);
    expect(await count("SELECT count(*) AS n FROM trips")).toBe(1);
  });

  it("stores late messages in the track but flags them and keeps them out of the trip", async () => {
    const msgs = trip("a", 1, T0);
    const late = msgs[5]!;
    const ing = new Ingestor(db, { reorder: { windowMs: 10_000, maxBuffered: 100 } });
    for (const m of msgs) if (m !== late) ing.submit(m);
    await ing.flush();
    ing.submit(late);
    await ing.drain();
    expect(ing.stats.late).toBe(1);
    const row = (await db.query<{ late: boolean }>("SELECT late FROM points WHERE seq = $1", [late.seq])).rows[0]!;
    expect(row.late).toBe(true);
    expect(await count("SELECT count(*) AS n FROM trips")).toBe(1);
  });

  it("rejects invalid raw payloads without storing anything", async () => {
    const ing = new Ingestor(db);
    expect(ing.submitRaw("fleet/a/telemetry", "not json")).toBe(false);
    expect(ing.submitRaw("fleet/a/telemetry", JSON.stringify({ deviceId: "b", seq: 1 }))).toBe(false);
    const ok = trip("a", 1, T0)[0]!;
    expect(ing.submitRaw("fleet/a/telemetry", JSON.stringify(ok))).toBe(true);
    await ing.drain();
    expect(ing.stats.invalid).toBe(2);
    expect(await count("SELECT count(*) AS n FROM points")).toBe(1);
  });

  it("rolls back the whole batch on a database error and retries it without losing or double-applying", async () => {
    let failNextTripInsert = true;
    const flaky: Db = {
      ...db,
      query: db.query,
      exec: db.exec,
      close: db.close,
      transaction: (fn) =>
        db.transaction((tx) => {
          const wrapped: Queryable = {
            query: async (sql, params) => {
              if (failNextTripInsert && sql.includes("INSERT INTO trips")) {
                failNextTripInsert = false;
                throw new Error("simulated failure");
              }
              return tx.query(sql, params);
            },
          };
          return fn(wrapped);
        }),
    };
    const ing = new Ingestor(flaky, { retryDelayMs: 10 });
    for (const m of trip("a", 1, T0)) ing.submit(m);
    await expect(ing.drain()).rejects.toThrow("simulated failure");
    // Nothing from the failed batch is visible.
    expect(await count("SELECT count(*) AS n FROM points")).toBe(0);
    expect(ing.stats.batchErrors).toBe(1);
    await ing.drain();
    expect(await count("SELECT count(*) AS n FROM points")).toBe(40);
    expect(await count("SELECT count(*) AS n FROM trips")).toBe(1);
    expect(ing.stats.tripsClosed).toBe(1);
  });

  it("recovers an open trip after a restart by replaying stored points", async () => {
    const fleet = generateFleet({ seed: 99, devices: 4, tripsPerDevice: 3 });
    const { deliveries } = injectFaults(fleet.messages, { seed: 100 });
    const half = Math.floor(deliveries.length / 2);

    const first = new Ingestor(db, { batchMaxDelayMs: 1e6 });
    for (const d of deliveries.slice(0, half)) first.submit(d.msg);
    await first.flush(); // simulate a crash: reorder buffers are not drained
    const openBefore = await count("SELECT count(*) AS n FROM devices WHERE state IN ('moving','idle')");

    const second = new Ingestor(db, { batchMaxDelayMs: 1e6 });
    expect(await second.recover()).toBe(4);
    for (const d of deliveries.slice(half)) second.submit(d.msg);
    await second.drain();

    const reference = await createPgliteDb();
    await migrate(reference);
    const single = new Ingestor(reference, { batchMaxDelayMs: 1e6 });
    for (const d of deliveries) single.submit(d.msg);
    await single.drain();

    const q = "SELECT device_id, start_seq, end_seq, distance_m FROM trips ORDER BY 1, 2";
    type Row = { device_id: string; start_seq: number; end_seq: number; distance_m: number };
    const restarted = (await db.query<Row>(q)).rows;
    const uninterrupted = (await reference.query<Row>(q)).rows;
    await reference.close();
    expect(openBefore).toBeGreaterThan(0); // the crash really happened mid-trip
    expect(restarted.length).toBe(fleet.trips.length);
    // Same trip boundaries. Distances can differ marginally: stragglers that were still buffered
    // at the crash are applied by the replay, so a few reordered messages after the restart are
    // classified late instead of being slotted in.
    expect(restarted.map(({ distance_m: _, ...k }) => k)).toEqual(uninterrupted.map(({ distance_m: _, ...k }) => k));
    restarted.forEach((r, i) => {
      expect(Math.abs(r.distance_m - uninterrupted[i]!.distance_m) / uninterrupted[i]!.distance_m).toBeLessThan(0.001);
    });
  });

  it("releases the reorder buffer of a quiet device on the stale sweep", async () => {
    let now = 1_000_000;
    const ing = new Ingestor(db, { staleFlushMs: 1000, now: () => now });
    const msgs = trip("a", 1, T0).slice(0, 3);
    for (const m of msgs) ing.submit(m);
    await ing.flush();
    // First messages wait for the reorder window (no known cursor yet).
    expect(ing.deviceState("a")?.last).toBeNull();
    now += 5000;
    (ing as unknown as { sweepStale(): void }).sweepStale();
    await new Promise((r) => setTimeout(r, 20));
    await ing.flush();
    expect(ing.deviceState("a")?.last?.seq).toBe(3);
    await ing.close();
  });
});
