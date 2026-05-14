/**
 * Accuracy sweep: runs many seeded fleets through the in-process pipeline (PGlite) and reports
 * how well trip count, distance and idle time match the simulator's ground truth.
 *
 *   npm run accuracy -- --seeds 20 --devices 50 --trips 4
 *
 * Results are written to results/accuracy.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createPgliteDb } from "../src/db/pglite.js";
import { migrate } from "../src/db/schema.js";
import { Ingestor } from "../src/ingest/ingestor.js";
import { DEFAULT_FAULTS, generateFleet, injectFaults } from "../src/sim/fleet.js";
import { numArg, parseArgs } from "./args.js";

const args = parseArgs();
const seeds = numArg(args, "seeds", 20);
const devices = numArg(args, "devices", 50);
const tripsPerDevice = numArg(args, "trips", 4);
const out = args.get("out") ?? "results/accuracy.json";

const errors: number[] = [];
let expectedTrips = 0;
let actualTrips = 0;
let countMismatches = 0;
let truthDistance = 0;
let measuredDistance = 0;
let truthIdle = 0;
let measuredIdle = 0;

for (let seed = 1; seed <= seeds; seed++) {
  const db = await createPgliteDb();
  await migrate(db);
  const fleet = generateFleet({ seed, devices, tripsPerDevice });
  const { deliveries } = injectFaults(fleet.messages, { seed: seed + 1000 });
  const ingestor = new Ingestor(db, { batchMaxDelayMs: 1e9 });
  for (const d of deliveries) ingestor.submit(d.msg);
  await ingestor.drain();
  const { rows } = await db.query<{ device_id: string; start_ts: Date; distance_m: number; idle_s: number }>(
    `SELECT device_id, start_ts, distance_m, idle_s FROM trips ORDER BY device_id, start_ts`,
  );
  await db.close();
  expectedTrips += fleet.trips.length;
  actualTrips += rows.length;
  const byDevice = new Map<string, typeof rows>();
  for (const r of rows) byDevice.set(r.device_id, [...(byDevice.get(r.device_id) ?? []), r]);
  for (const id of new Set(fleet.trips.map((t) => t.deviceId))) {
    const truth = fleet.trips.filter((t) => t.deviceId === id);
    const got = byDevice.get(id) ?? [];
    if (truth.length !== got.length) {
      countMismatches++;
      continue;
    }
    truth.forEach((t, i) => {
      const g = got[i]!;
      errors.push((g.distance_m - t.distanceM) / t.distanceM);
      truthDistance += t.distanceM;
      measuredDistance += g.distance_m;
      truthIdle += t.idleMs / 1000;
      measuredIdle += g.idle_s;
    });
  }
  process.stdout.write(".");
}
console.log();

const abs = errors.map(Math.abs).sort((a, b) => a - b);
const q = (p: number) => abs[Math.min(abs.length - 1, Math.ceil(p * abs.length) - 1)]!;
const pct = (x: number) => Math.round(x * 10000) / 100;
const summary = {
  measuredAt: new Date().toISOString(),
  config: { seeds, devices, tripsPerDevice, faults: DEFAULT_FAULTS },
  trips: { expected: expectedTrips, actual: actualTrips, devicesWithCountMismatch: countMismatches },
  distanceErrorPct: {
    medianAbs: pct(q(0.5)),
    p95Abs: pct(q(0.95)),
    p99Abs: pct(q(0.99)),
    maxAbs: pct(abs.at(-1) ?? 0),
    meanSigned: pct(errors.reduce((a, b) => a + b, 0) / errors.length),
    tripsWithin1Pct: errors.filter((e) => Math.abs(e) < 0.01).length,
    tripsCompared: errors.length,
    fleetTotal: pct((measuredDistance - truthDistance) / truthDistance),
  },
  idleErrorPct: { fleetTotal: pct((measuredIdle - truthIdle) / truthIdle) },
};
mkdirSync("results", { recursive: true });
writeFileSync(out, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
