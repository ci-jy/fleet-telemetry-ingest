import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApi } from "../src/api/server.js";
import type { Db } from "../src/db/db.js";
import { createPgliteDb } from "../src/db/pglite.js";
import { migrate } from "../src/db/schema.js";
import { Ingestor } from "../src/ingest/ingestor.js";
import { generateFleet, injectFaults } from "../src/sim/fleet.js";

let db: Db;
let app: FastifyInstance;
let ingestor: Ingestor;
const fleet = generateFleet({ seed: 5, devices: 3, tripsPerDevice: 2 });

beforeAll(async () => {
  db = await createPgliteDb();
  await migrate(db);
  ingestor = new Ingestor(db, { batchMaxDelayMs: 1e6 });
  for (const d of injectFaults(fleet.messages, { seed: 6 }).deliveries) ingestor.submit(d.msg);
  await ingestor.drain();
  app = await buildApi({ db, stats: () => ingestor.stats, webDist: null });
});
afterAll(async () => {
  await app.close();
  await db.close();
});

describe("REST API", () => {
  it("GET /health", async () => {
    const r = await app.inject({ url: "/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: "ok" });
  });

  it("lists devices with state and trip totals", async () => {
    const devices = (await app.inject({ url: "/api/devices" })).json();
    expect(devices.map((d: { deviceId: string }) => d.deviceId)).toEqual(["veh-0001", "veh-0002", "veh-0003"]);
    for (const d of devices) {
      expect(d.tripCount).toBe(2);
      expect(d.state).toBe("parked");
      expect(d.lastPosition).toMatchObject({ lat: expect.any(Number), lon: expect.any(Number) });
    }
  });

  it("returns one device with totals, 404 for unknown", async () => {
    const r = await app.inject({ url: "/api/devices/veh-0002" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.totals.trips).toBe(2);
    const truth = fleet.trips.filter((t) => t.deviceId === "veh-0002").reduce((a, t) => a + t.distanceM, 0);
    expect(Math.abs(body.totals.distanceKm * 1000 - truth) / truth).toBeLessThan(0.01);
    expect((await app.inject({ url: "/api/devices/nope" })).statusCode).toBe(404);
  });

  it("lists trips of a device with distance, duration and idle time", async () => {
    const trips = (await app.inject({ url: "/api/devices/veh-0001/trips" })).json();
    expect(trips).toHaveLength(2);
    const truth = fleet.trips.filter((t) => t.deviceId === "veh-0001").sort((a, b) => b.startTs - a.startTs);
    trips.forEach((t: { distanceKm: number; durationS: number; idleS: number; movingS: number; endReason: string }, i: number) => {
      expect(Math.abs(t.distanceKm * 1000 - truth[i]!.distanceM) / truth[i]!.distanceM).toBeLessThan(0.01);
      expect(t.durationS).toBeGreaterThan(0);
      expect(t.movingS).toBeCloseTo(t.durationS - t.idleS, 6);
      expect(t.endReason).toBe("ignition_off");
    });
  });

  it("filters trips by time and validates query parameters", async () => {
    const all = (await app.inject({ url: "/api/trips?limit=100" })).json();
    expect(all).toHaveLength(6);
    const latest = all[0];
    const after = (await app.inject({ url: `/api/trips?from=${encodeURIComponent(latest.startTs)}` })).json();
    expect(after.length).toBeGreaterThanOrEqual(1);
    expect(after.length).toBeLessThan(6);
    expect((await app.inject({ url: "/api/trips?limit=0" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/trips?from=notadate" })).statusCode).toBe(400);
  });

  it("returns a trip with idle segments and its raw track", async () => {
    const [first] = (await app.inject({ url: "/api/trips?limit=1" })).json();
    const trip = (await app.inject({ url: `/api/trips/${first.id}` })).json();
    expect(Array.isArray(trip.idleSegments)).toBe(true);
    const track = (await app.inject({ url: `/api/trips/${first.id}/track` })).json();
    expect(track[0].seq).toBe(trip.startSeq);
    expect(track.at(-1).seq).toBe(trip.endSeq);
    const seqs = track.map((p: { seq: number }) => p.seq);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect((await app.inject({ url: "/api/trips/999999" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/trips/abc" })).statusCode).toBe(400);
  });

  it("returns a device's raw track, optionally without late points", async () => {
    const track = (await app.inject({ url: "/api/devices/veh-0003/track?limit=20000" })).json();
    const stored = fleet.messages.filter((m) => m.deviceId === "veh-0003").length;
    expect(track.length).toBeLessThanOrEqual(stored);
    expect(track.length).toBeGreaterThan(stored * 0.9);
    const noLate = (await app.inject({ url: "/api/devices/veh-0003/track?limit=20000&includeLate=false" })).json();
    expect(noLate.every((p: { late: boolean }) => !p.late)).toBe(true);
  });

  it("reports stored counts and ingest counters", async () => {
    const s = (await app.inject({ url: "/api/stats" })).json();
    expect(s.stored.trips).toBe(6);
    expect(s.ingest.stored).toBe(s.stored.points);
  });
});
