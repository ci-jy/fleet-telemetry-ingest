import type { Db } from "../../src/db/db.js";
import type { GroundTruthTrip } from "../../src/sim/fleet.js";

export interface StoredTrip {
  device_id: string;
  start_ts: Date;
  end_ts: Date;
  distance_m: number;
  idle_s: number;
  end_reason: string;
}

export async function loadTrips(db: Db): Promise<StoredTrip[]> {
  const { rows } = await db.query<StoredTrip>(
    `SELECT device_id, start_ts, end_ts, distance_m, idle_s, end_reason FROM trips ORDER BY device_id, start_ts`,
  );
  return rows;
}

export interface Comparison {
  expectedTrips: number;
  actualTrips: number;
  maxDistanceError: number;
  maxIdleErrorS: number;
  perDeviceCountMismatch: string[];
}

/** Pairs stored trips with ground-truth trips (per device, in time order) and reports the errors. */
export function compareTrips(truth: GroundTruthTrip[], stored: StoredTrip[]): Comparison {
  const byDevice = new Map<string, { truth: GroundTruthTrip[]; stored: StoredTrip[] }>();
  const get = (id: string) => {
    let e = byDevice.get(id);
    if (!e) byDevice.set(id, (e = { truth: [], stored: [] }));
    return e;
  };
  for (const t of truth) get(t.deviceId).truth.push(t);
  for (const s of stored) get(s.device_id).stored.push(s);
  let maxDistanceError = 0;
  let maxIdleErrorS = 0;
  const mismatch: string[] = [];
  for (const [id, e] of byDevice) {
    if (e.truth.length !== e.stored.length) {
      mismatch.push(`${id}: expected ${e.truth.length}, got ${e.stored.length}`);
      continue;
    }
    e.truth.sort((a, b) => a.startTs - b.startTs);
    e.stored.sort((a, b) => new Date(a.start_ts).getTime() - new Date(b.start_ts).getTime());
    e.truth.forEach((t, i) => {
      const s = e.stored[i]!;
      maxDistanceError = Math.max(maxDistanceError, Math.abs(s.distance_m - t.distanceM) / t.distanceM);
      maxIdleErrorS = Math.max(maxIdleErrorS, Math.abs(s.idle_s - t.idleMs / 1000));
    });
  }
  return {
    expectedTrips: truth.length,
    actualTrips: stored.length,
    maxDistanceError,
    maxIdleErrorS,
    perDeviceCountMismatch: mismatch,
  };
}
