import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.js";
import { createPgliteDb } from "../src/db/pglite.js";
import { migrate } from "../src/db/schema.js";
import { Ingestor } from "../src/ingest/ingestor.js";
import { generateFleet, injectFaults } from "../src/sim/fleet.js";
import { compareTrips, loadTrips } from "./helpers/fleetCheck.js";

let db: Db | null = null;
afterEach(async () => {
  await db?.close();
  db = null;
});

describe("seeded fleet replay (in-process)", () => {
  it.each([42, 1337])("reproduces ground-truth trips for seed %i", async (seed) => {
    db = await createPgliteDb();
    await migrate(db);
    const fleet = generateFleet({ seed, devices: 12, tripsPerDevice: 4 });
    const { deliveries, stats } = injectFaults(fleet.messages, { seed: seed + 1 });
    expect(stats.dropped).toBeGreaterThan(0);
    expect(stats.duplicates).toBeGreaterThan(0);
    expect(stats.reordered).toBeGreaterThan(0);

    const ingestor = new Ingestor(db, { batchMaxSize: 500, batchMaxDelayMs: 1_000_000 });
    for (const d of deliveries) ingestor.submit(d.msg);
    await ingestor.drain();

    const cmp = compareTrips(fleet.trips, await loadTrips(db));
    expect(cmp.perDeviceCountMismatch).toEqual([]);
    expect(cmp.actualTrips).toBe(fleet.trips.length);
    expect(cmp.maxDistanceError).toBeLessThan(0.01);
    expect(ingestor.stats.duplicates).toBe(stats.duplicates);
    console.log(seed, cmp, ingestor.stats, stats);
  });
});
