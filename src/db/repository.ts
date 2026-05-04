import type { ClosedTrip, DeviceTripState, Point } from "../domain/tripStateMachine.js";
import type { Telemetry } from "../domain/telemetry.js";
import type { Queryable } from "./db.js";

export interface IncomingPoint {
  msg: Telemetry;
  receivedAt: number;
}

/**
 * Inserts raw points idempotently in one statement and returns the keys that were new.
 * Rows that already exist (redelivered messages) are skipped by the primary key.
 */
export async function insertPoints(tx: Queryable, batch: readonly IncomingPoint[]): Promise<Set<string>> {
  if (batch.length === 0) return new Set();
  const cols: unknown[][] = [[], [], [], [], [], [], [], []];
  for (const { msg, receivedAt } of batch) {
    cols[0]!.push(msg.deviceId);
    cols[1]!.push(msg.seq);
    cols[2]!.push(msg.ts);
    cols[3]!.push(msg.lat);
    cols[4]!.push(msg.lon);
    cols[5]!.push(msg.speedKph);
    cols[6]!.push(msg.ignition);
    cols[7]!.push(receivedAt);
  }
  const { rows } = await tx.query<{ device_id: string; seq: number }>(
    `INSERT INTO points (device_id, seq, ts, lat, lon, speed_kph, ignition, received_at)
     SELECT d, s, to_timestamp(t / 1000.0), la, lo, sp, ig, to_timestamp(r / 1000.0)
     FROM unnest($1::text[], $2::bigint[], $3::float8[], $4::float8[], $5::float8[],
                 $6::real[], $7::boolean[], $8::float8[]) AS u(d, s, t, la, lo, sp, ig, r)
     ON CONFLICT (device_id, seq) DO NOTHING
     RETURNING device_id, seq`,
    cols,
  );
  return new Set(rows.map((r) => pointKey(r.device_id, Number(r.seq))));
}

export const pointKey = (deviceId: string, seq: number): string => `${deviceId}\u0000${seq}`;

export async function markLate(tx: Queryable, late: readonly { deviceId: string; seq: number }[]): Promise<void> {
  if (late.length === 0) return;
  await tx.query(
    `UPDATE points p SET late = true
     FROM unnest($1::text[], $2::bigint[]) AS u(d, s)
     WHERE p.device_id = u.d AND p.seq = u.s`,
    [late.map((l) => l.deviceId), late.map((l) => l.seq)],
  );
}

/** Writes a closed trip and its idle segments. Re-inserting the same trip (replay) is a no-op. */
export async function insertTrip(tx: Queryable, deviceId: string, trip: ClosedTrip): Promise<number | null> {
  const { rows } = await tx.query<{ id: number }>(
    `INSERT INTO trips (device_id, start_seq, end_seq, start_ts, end_ts, start_lat, start_lon, end_lat, end_lon,
                        distance_m, duration_s, idle_s, point_count, max_speed_kph, end_reason)
     VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), to_timestamp($5 / 1000.0), $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (device_id, start_seq) DO NOTHING
     RETURNING id`,
    [
      deviceId,
      trip.startSeq,
      trip.endSeq,
      trip.startTs,
      trip.endTs,
      trip.startLat,
      trip.startLon,
      trip.endLat,
      trip.endLon,
      trip.distanceM,
      trip.durationMs / 1000,
      trip.idleMs / 1000,
      trip.pointCount,
      trip.maxSpeedKph,
      trip.endReason,
    ],
  );
  const id = rows[0]?.id;
  if (id === undefined) return null;
  if (trip.idleSegments.length > 0) {
    const segs = trip.idleSegments;
    await tx.query(
      `INSERT INTO idle_segments (trip_id, device_id, start_seq, start_ts, end_ts, duration_s)
       SELECT $1, $2, s, to_timestamp(st / 1000.0), to_timestamp(et / 1000.0), du
       FROM unnest($3::bigint[], $4::float8[], $5::float8[], $6::float8[]) AS u(s, st, et, du)
       ON CONFLICT (device_id, start_seq) DO NOTHING`,
      [
        id,
        deviceId,
        segs.map((s) => s.startSeq),
        segs.map((s) => s.startTs),
        segs.map((s) => s.endTs),
        segs.map((s) => s.durationMs / 1000),
      ],
    );
  }
  return Number(id);
}

/** Upserts the current state of many devices in one statement. */
export async function upsertDevices(
  tx: Queryable,
  devices: readonly { deviceId: string; state: DeviceTripState }[],
): Promise<void> {
  if (devices.length === 0) return;
  const ids: string[] = [];
  const states: string[] = [];
  const seqs: (number | null)[] = [];
  const tss: (number | null)[] = [];
  const lats: (number | null)[] = [];
  const lons: (number | null)[] = [];
  const speeds: (number | null)[] = [];
  const igns: (boolean | null)[] = [];
  const trips: (string | null)[] = [];
  for (const { deviceId, state } of devices) {
    ids.push(deviceId);
    states.push(state.state);
    const l = state.last;
    seqs.push(l?.seq ?? null);
    tss.push(l?.ts ?? null);
    lats.push(l?.lat ?? null);
    lons.push(l?.lon ?? null);
    speeds.push(l?.speedKph ?? null);
    igns.push(l?.ignition ?? null);
    const t = state.trip;
    trips.push(
      t
        ? JSON.stringify({
            startSeq: t.startSeq,
            startTs: new Date(t.startTs).toISOString(),
            distanceM: t.distanceM,
            pointCount: t.pointCount,
            idleSegments: t.idleSegments.length,
          })
        : null,
    );
  }
  await tx.query(
    `INSERT INTO devices (device_id, state, last_seq, last_ts, last_lat, last_lon, last_speed_kph, last_ignition, open_trip, updated_at)
     SELECT d, st, sq, CASE WHEN t IS NULL THEN NULL ELSE to_timestamp(t / 1000.0) END, la, lo, sp, ig, ot::jsonb, now()
     FROM unnest($1::text[], $2::text[], $3::bigint[], $4::float8[], $5::float8[], $6::float8[], $7::real[], $8::boolean[], $9::text[])
       AS u(d, st, sq, t, la, lo, sp, ig, ot)
     ON CONFLICT (device_id) DO UPDATE SET
       state = EXCLUDED.state,
       last_seq = COALESCE(EXCLUDED.last_seq, devices.last_seq),
       last_ts = COALESCE(EXCLUDED.last_ts, devices.last_ts),
       last_lat = COALESCE(EXCLUDED.last_lat, devices.last_lat),
       last_lon = COALESCE(EXCLUDED.last_lon, devices.last_lon),
       last_speed_kph = COALESCE(EXCLUDED.last_speed_kph, devices.last_speed_kph),
       last_ignition = COALESCE(EXCLUDED.last_ignition, devices.last_ignition),
       open_trip = EXCLUDED.open_trip,
       updated_at = now()`,
    [ids, states, seqs, tss, lats, lons, speeds, igns, trips],
  );
}

export interface PointRow {
  seq: number;
  ts: Date;
  lat: number;
  lon: number;
  speed_kph: number;
  ignition: boolean;
}

export const rowToPoint = (r: PointRow): Point => ({
  seq: Number(r.seq),
  ts: new Date(r.ts).getTime(),
  lat: r.lat,
  lon: r.lon,
  speedKph: r.speed_kph,
  ignition: r.ignition,
});

export interface ReplayInput {
  /** End of the last persisted trip, if any. */
  lastTrip: { endSeq: number; endReason: string; endPoint: Point | null } | null;
  /** Points applied after that trip, in sequence order, excluding late arrivals. */
  points: Point[];
  /** Highest sequence number stored for the device (including late ones). */
  maxSeq: number | null;
}

/** Loads everything needed to rebuild one device's in-memory state by replaying its stored points. */
export async function loadReplayInput(db: Queryable, deviceId: string): Promise<ReplayInput> {
  const trip = await db.query<{ end_seq: number; end_reason: string }>(
    `SELECT end_seq, end_reason FROM trips WHERE device_id = $1 ORDER BY end_seq DESC LIMIT 1`,
    [deviceId],
  );
  const t = trip.rows[0];
  let lastTrip: ReplayInput["lastTrip"] = null;
  if (t) {
    const end = await db.query<PointRow>(
      `SELECT seq, ts, lat, lon, speed_kph, ignition FROM points WHERE device_id = $1 AND seq = $2`,
      [deviceId, t.end_seq],
    );
    lastTrip = {
      endSeq: Number(t.end_seq),
      endReason: t.end_reason,
      endPoint: end.rows[0] ? rowToPoint(end.rows[0]) : null,
    };
  }
  const pts = await db.query<PointRow>(
    `SELECT seq, ts, lat, lon, speed_kph, ignition FROM points
     WHERE device_id = $1 AND NOT late AND seq > $2 ORDER BY seq`,
    [deviceId, lastTrip?.endSeq ?? -1],
  );
  const max = await db.query<{ m: number | null }>(`SELECT max(seq) AS m FROM points WHERE device_id = $1`, [
    deviceId,
  ]);
  const m = max.rows[0]?.m;
  return { lastTrip, points: pts.rows.map(rowToPoint), maxSeq: m === null || m === undefined ? null : Number(m) };
}
