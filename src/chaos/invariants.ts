/**
 * Invariants checked after every fault-injection run. Pure functions over rows read from the
 * database, so they can be unit-tested without the environment.
 *
 * - No lost messages: every (device, seq) the simulator delivered at least once is stored.
 * - No duplicates: no (device, seq) is stored twice, no trip (device, start_seq) twice, no idle
 *   segment twice. The primary keys forbid this; the checker verifies it rather than assuming it.
 * - No phantoms: nothing is stored that the simulator never sent.
 * - Same result as a fault-free run: trips, idle segments and late flags are identical.
 */

export interface PointKeyRow {
  device_id: string;
  seq: number;
}

export interface TripRow {
  device_id: string;
  start_seq: number;
  end_seq: number;
  start_ts: string;
  end_ts: string;
  distance_m: number;
  duration_s: number;
  idle_s: number;
  point_count: number;
  max_speed_kph: number;
  end_reason: string;
}

export interface IdleSegmentRow {
  device_id: string;
  start_seq: number;
  start_ts: string;
  end_ts: string;
  duration_s: number;
}

/** What a run stored, as read back from PostgreSQL. */
export interface RunSnapshot {
  points: PointKeyRow[];
  latePoints: PointKeyRow[];
  trips: TripRow[];
  idleSegments: IdleSegmentRow[];
}

export interface InvariantReport {
  expected: number;
  stored: number;
  /** Delivered (device, seq) pairs missing from storage. */
  lost: number;
  /** (device, seq) pairs stored more than once, counting every extra copy. */
  duplicates: number;
  /** Trips or idle segments stored more than once. */
  duplicateTrips: number;
  /** Stored points the simulator never delivered. */
  phantom: number;
  /** Differences from the fault-free run (empty when identical). */
  tripDiffs: string[];
  tripsMatch: boolean;
  ok: boolean;
  /** A few examples of lost / duplicate keys for diagnosis. */
  examples: string[];
}

const key = (deviceId: string, seq: number | string): string => `${deviceId}#${Number(seq)}`;

/** Floating-point columns are compared to this many significant digits (distances in metres). */
const close = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

function countKeys(rows: readonly PointKeyRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = key(r.device_id, r.seq);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

const tripKey = (t: TripRow): string => key(t.device_id, t.start_seq);

/** Lists field-level differences between two trip sets keyed by (device, start_seq). */
export function diffTrips(baseline: readonly TripRow[], actual: readonly TripRow[], limit = 20): string[] {
  const out: string[] = [];
  const base = new Map(baseline.map((t) => [tripKey(t), t]));
  const got = new Map(actual.map((t) => [tripKey(t), t]));
  for (const [k, b] of base) {
    const a = got.get(k);
    if (!a) {
      out.push(`trip ${k} missing`);
      continue;
    }
    for (const f of Object.keys(b) as (keyof TripRow)[]) {
      const bv = b[f];
      const av = a[f];
      const same =
        typeof bv === "number" && typeof av === "number" ? close(bv, av) : String(bv) === String(av);
      if (!same) out.push(`trip ${k} ${f}: expected ${String(bv)}, got ${String(av)}`);
    }
  }
  for (const k of got.keys()) if (!base.has(k)) out.push(`trip ${k} unexpected`);
  return out.slice(0, limit);
}

function diffIdle(baseline: readonly IdleSegmentRow[], actual: readonly IdleSegmentRow[]): string[] {
  const norm = (rows: readonly IdleSegmentRow[]) =>
    new Map(rows.map((r) => [key(r.device_id, r.start_seq), `${r.start_ts}|${r.end_ts}|${Number(r.duration_s)}`]));
  const b = norm(baseline);
  const a = norm(actual);
  const out: string[] = [];
  for (const [k, v] of b) if (a.get(k) !== v) out.push(`idle segment ${k}: expected ${v}, got ${a.get(k) ?? "none"}`);
  for (const k of a.keys()) if (!b.has(k)) out.push(`idle segment ${k} unexpected`);
  return out;
}

function diffKeys(label: string, baseline: readonly PointKeyRow[], actual: readonly PointKeyRow[]): string[] {
  const b = new Set(baseline.map((r) => key(r.device_id, r.seq)));
  const a = new Set(actual.map((r) => key(r.device_id, r.seq)));
  const out: string[] = [];
  for (const k of b) if (!a.has(k)) out.push(`${label} ${k} missing`);
  for (const k of a) if (!b.has(k)) out.push(`${label} ${k} unexpected`);
  return out;
}

/**
 * Checks a run against the simulator's deliveries and, when given, the fault-free run's snapshot.
 * `delivered` is every (device, seq) the simulator handed to the broker (copies allowed).
 */
export function checkInvariants(
  delivered: readonly { deviceId: string; seq: number }[],
  run: RunSnapshot,
  baseline?: RunSnapshot,
): InvariantReport {
  const expected = new Set(delivered.map((d) => key(d.deviceId, d.seq)));
  const stored = countKeys(run.points);
  const examples: string[] = [];
  let lost = 0;
  for (const k of expected) {
    if (!stored.has(k)) {
      lost++;
      if (examples.length < 10) examples.push(`lost ${k}`);
    }
  }
  let duplicates = 0;
  let phantom = 0;
  for (const [k, n] of stored) {
    if (n > 1) {
      duplicates += n - 1;
      if (examples.length < 10) examples.push(`duplicate ${k} x${n}`);
    }
    if (!expected.has(k)) phantom++;
  }
  const tripCounts = new Map<string, number>();
  for (const t of run.trips) tripCounts.set(tripKey(t), (tripCounts.get(tripKey(t)) ?? 0) + 1);
  for (const s of run.idleSegments) {
    const k = `idle:${key(s.device_id, s.start_seq)}`;
    tripCounts.set(k, (tripCounts.get(k) ?? 0) + 1);
  }
  let duplicateTrips = 0;
  for (const n of tripCounts.values()) if (n > 1) duplicateTrips += n - 1;

  const tripDiffs = baseline
    ? [
        ...diffTrips(baseline.trips, run.trips),
        ...diffIdle(baseline.idleSegments, run.idleSegments),
        ...diffKeys("late point", baseline.latePoints, run.latePoints),
      ].slice(0, 30)
    : [];
  if (baseline && baseline.trips.length !== run.trips.length) {
    tripDiffs.unshift(`trip count: expected ${baseline.trips.length}, got ${run.trips.length}`);
  }
  const tripsMatch = tripDiffs.length === 0;
  return {
    expected: expected.size,
    stored: run.points.length,
    lost,
    duplicates,
    duplicateTrips,
    phantom,
    tripDiffs,
    tripsMatch,
    ok: lost === 0 && duplicates === 0 && duplicateTrips === 0 && phantom === 0 && tripsMatch,
    examples,
  };
}
