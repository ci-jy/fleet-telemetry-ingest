import { existsSync } from "node:fs";
import { resolve } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import type { Registry } from "prom-client";
import { z } from "zod";
import type { Db } from "../db/db.js";
import type { IngestStats } from "../ingest/ingestor.js";

export interface ApiOptions {
  db: Db;
  stats?: () => IngestStats;
  webDist?: string | null;
  logger?: boolean;
  /** Prometheus registry served on GET /metrics. */
  metrics?: Registry;
  /** Partition ownership of this pod (partitioned mode), reported in /api/stats. */
  cluster?: () => unknown;
}

const deviceParams = z.object({ deviceId: z.string().min(1).max(64) });
const tripParams = z.object({ tripId: z.coerce.number().int().positive() });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
const trackQuery = listQuery.extend({
  limit: z.coerce.number().int().min(1).max(20_000).default(5000),
  includeLate: z.enum(["true", "false"]).default("true"),
});

const TRIP_COLUMNS = `id, device_id, start_seq, end_seq, start_ts, end_ts, start_lat, start_lon, end_lat, end_lon,
  distance_m, duration_s, idle_s, point_count, max_speed_kph, end_reason`;

interface TripRow {
  id: number;
  device_id: string;
  start_seq: number;
  end_seq: number;
  start_ts: Date;
  end_ts: Date;
  start_lat: number;
  start_lon: number;
  end_lat: number;
  end_lon: number;
  distance_m: number;
  duration_s: number;
  idle_s: number;
  point_count: number;
  max_speed_kph: number;
  end_reason: string;
}

const iso = (d: Date | string | null): string | null => (d === null ? null : new Date(d).toISOString());

const tripDto = (r: TripRow) => ({
  id: Number(r.id),
  deviceId: r.device_id,
  startSeq: Number(r.start_seq),
  endSeq: Number(r.end_seq),
  startTs: iso(r.start_ts),
  endTs: iso(r.end_ts),
  start: { lat: r.start_lat, lon: r.start_lon },
  end: { lat: r.end_lat, lon: r.end_lon },
  distanceKm: Math.round(r.distance_m) / 1000,
  durationS: r.duration_s,
  idleS: r.idle_s,
  movingS: Math.max(0, r.duration_s - r.idle_s),
  avgSpeedKph: r.duration_s > 0 ? Math.round((r.distance_m / r.duration_s) * 3.6 * 10) / 10 : 0,
  maxSpeedKph: r.max_speed_kph,
  pointCount: r.point_count,
  endReason: r.end_reason,
});

export async function buildApi(opts: ApiOptions): Promise<FastifyInstance> {
  const { db } = opts;
  const app = Fastify({ logger: opts.logger ?? false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: "bad_request", issues: err.issues.map((i) => i.message) });
    }
    app.log.error(err);
    return reply.status(500).send({ error: "internal_error" });
  });

  app.get("/health", async () => {
    await db.query("SELECT 1");
    return { status: "ok" };
  });

  app.get("/api/stats", async () => {
    const { rows } = await db.query<{ devices: number; points: number; trips: number; late: number }>(
      `SELECT (SELECT count(*) FROM devices) AS devices, (SELECT count(*) FROM points) AS points,
              (SELECT count(*) FROM trips) AS trips, (SELECT count(*) FROM points WHERE late) AS late`,
    );
    const r = rows[0]!;
    return {
      stored: { devices: Number(r.devices), points: Number(r.points), trips: Number(r.trips), latePoints: Number(r.late) },
      ingest: opts.stats?.() ?? null,
      ...(opts.cluster ? { cluster: opts.cluster() } : {}),
    };
  });

  const registry = opts.metrics;
  if (registry) {
    app.get("/metrics", async (_req, reply) => {
      reply.header("content-type", registry.contentType);
      return registry.metrics();
    });
  }

  const listDevices = async (deviceId: string | null) => {
    const { rows } = await db.query<{
      device_id: string;
      state: string;
      last_seq: number | null;
      last_ts: Date | null;
      last_lat: number | null;
      last_lon: number | null;
      last_speed_kph: number | null;
      last_ignition: boolean | null;
      open_trip: unknown;
      trip_count: number;
      total_distance_m: number;
    }>(
      `SELECT d.*, coalesce(t.n, 0) AS trip_count, coalesce(t.dist, 0) AS total_distance_m
       FROM devices d
       LEFT JOIN (SELECT device_id, count(*) AS n, sum(distance_m) AS dist FROM trips GROUP BY device_id) t
         USING (device_id)
       WHERE $1::text IS NULL OR d.device_id = $1
       ORDER BY d.device_id`,
      [deviceId],
    );
    return rows.map((r) => ({
      deviceId: r.device_id,
      state: r.state,
      lastSeq: r.last_seq === null ? null : Number(r.last_seq),
      lastTs: iso(r.last_ts),
      lastPosition: r.last_lat === null ? null : { lat: r.last_lat, lon: r.last_lon },
      lastSpeedKph: r.last_speed_kph,
      ignition: r.last_ignition,
      openTrip: typeof r.open_trip === "string" ? JSON.parse(r.open_trip) : r.open_trip,
      tripCount: Number(r.trip_count),
      totalDistanceKm: Math.round(Number(r.total_distance_m)) / 1000,
    }));
  };

  app.get("/api/devices", async () => listDevices(null));

  app.get("/api/devices/:deviceId", async (req, reply) => {
    const { deviceId } = deviceParams.parse(req.params);
    const [device] = await listDevices(deviceId);
    if (!device) return reply.status(404).send({ error: "not_found" });
    const summary = await db.query<{ n: number; dist: number | null; dur: number | null; idle: number | null }>(
      `SELECT count(*) AS n, sum(distance_m) AS dist, sum(duration_s) AS dur, sum(idle_s) AS idle
       FROM trips WHERE device_id = $1`,
      [deviceId],
    );
    const s = summary.rows[0]!;
    return {
      ...device,
      totals: {
        trips: Number(s.n),
        distanceKm: Math.round(Number(s.dist ?? 0)) / 1000,
        durationS: Number(s.dur ?? 0),
        idleS: Number(s.idle ?? 0),
      },
    };
  });

  app.get("/api/devices/:deviceId/trips", async (req) => {
    const { deviceId } = deviceParams.parse(req.params);
    const q = listQuery.parse(req.query);
    const { rows } = await db.query<TripRow>(
      `SELECT ${TRIP_COLUMNS} FROM trips
       WHERE device_id = $1 AND ($2::timestamptz IS NULL OR end_ts >= $2) AND ($3::timestamptz IS NULL OR start_ts <= $3)
       ORDER BY start_ts DESC LIMIT $4`,
      [deviceId, q.from ?? null, q.to ?? null, q.limit],
    );
    return rows.map(tripDto);
  });

  app.get("/api/trips", async (req) => {
    const q = listQuery.parse(req.query);
    const { rows } = await db.query<TripRow>(
      `SELECT ${TRIP_COLUMNS} FROM trips
       WHERE ($1::timestamptz IS NULL OR end_ts >= $1) AND ($2::timestamptz IS NULL OR start_ts <= $2)
       ORDER BY start_ts DESC LIMIT $3`,
      [q.from ?? null, q.to ?? null, q.limit],
    );
    return rows.map(tripDto);
  });

  app.get("/api/trips/:tripId", async (req, reply) => {
    const { tripId } = tripParams.parse(req.params);
    const { rows } = await db.query<TripRow>(`SELECT ${TRIP_COLUMNS} FROM trips WHERE id = $1`, [tripId]);
    if (rows.length === 0) return reply.status(404).send({ error: "not_found" });
    const idle = await db.query<{ start_seq: number; start_ts: Date; end_ts: Date; duration_s: number }>(
      `SELECT start_seq, start_ts, end_ts, duration_s FROM idle_segments WHERE trip_id = $1 ORDER BY start_ts`,
      [tripId],
    );
    return {
      ...tripDto(rows[0]!),
      idleSegments: idle.rows.map((s) => ({
        startSeq: Number(s.start_seq),
        startTs: iso(s.start_ts),
        endTs: iso(s.end_ts),
        durationS: s.duration_s,
      })),
    };
  });

  const trackRows = async (deviceId: string, fromSeq: number, toSeq: number, limit: number, includeLate: boolean, from?: Date, to?: Date) => {
    const { rows } = await db.query<{
      seq: number;
      ts: Date;
      lat: number;
      lon: number;
      speed_kph: number;
      ignition: boolean;
      late: boolean;
    }>(
      `SELECT seq, ts, lat, lon, speed_kph, ignition, late FROM points
       WHERE device_id = $1 AND seq BETWEEN $2 AND $3
         AND ($4::timestamptz IS NULL OR ts >= $4) AND ($5::timestamptz IS NULL OR ts <= $5)
         AND ($6 OR NOT late)
       ORDER BY seq LIMIT $7`,
      [deviceId, fromSeq, toSeq, from ?? null, to ?? null, includeLate, limit],
    );
    return rows.map((r) => ({
      seq: Number(r.seq),
      ts: iso(r.ts),
      lat: r.lat,
      lon: r.lon,
      speedKph: r.speed_kph,
      ignition: r.ignition,
      late: r.late,
    }));
  };

  app.get("/api/devices/:deviceId/track", async (req) => {
    const { deviceId } = deviceParams.parse(req.params);
    const q = trackQuery.parse(req.query);
    return trackRows(deviceId, 0, Number.MAX_SAFE_INTEGER, q.limit, q.includeLate === "true", q.from, q.to);
  });

  app.get("/api/trips/:tripId/track", async (req, reply) => {
    const { tripId } = tripParams.parse(req.params);
    const q = trackQuery.parse(req.query);
    const { rows } = await db.query<{ device_id: string; start_seq: number; end_seq: number }>(
      `SELECT device_id, start_seq, end_seq FROM trips WHERE id = $1`,
      [tripId],
    );
    const t = rows[0];
    if (!t) return reply.status(404).send({ error: "not_found" });
    return trackRows(t.device_id, Number(t.start_seq), Number(t.end_seq), q.limit, q.includeLate === "true");
  });

  if (opts.webDist) {
    const root = resolve(opts.webDist);
    if (existsSync(root)) await app.register(fastifyStatic, { root, prefix: "/" });
  }

  return app;
}
