import { describe, expect, it } from "vitest";
import { checkInvariants, diffTrips, type RunSnapshot, type TripRow } from "../src/chaos/invariants.js";

const trip = (over: Partial<TripRow> = {}): TripRow => ({
  device_id: "a",
  start_seq: 10,
  end_seq: 40,
  start_ts: "2026-01-05 06:10:00+00",
  end_ts: "2026-01-05 06:20:00+00",
  distance_m: 5321.123456789,
  duration_s: 600,
  idle_s: 75,
  point_count: 31,
  max_speed_kph: 61.5,
  end_reason: "ignition_off",
  ...over,
});

const snapshot = (over: Partial<RunSnapshot> = {}): RunSnapshot => ({
  points: [1, 2, 3].map((seq) => ({ device_id: "a", seq })),
  latePoints: [],
  trips: [trip()],
  idleSegments: [{ device_id: "a", start_seq: 20, start_ts: "t1", end_ts: "t2", duration_s: 75 }],
  ...over,
});

const delivered = [1, 2, 3, 2, 3].map((seq) => ({ deviceId: "a", seq })); // copies are fine

describe("checkInvariants", () => {
  it("passes a run that stored every delivered message once and matches the baseline", () => {
    const r = checkInvariants(delivered, snapshot(), snapshot());
    expect(r).toMatchObject({ expected: 3, stored: 3, lost: 0, duplicates: 0, phantom: 0, tripsMatch: true, ok: true });
  });

  it("counts lost messages", () => {
    const r = checkInvariants(delivered, snapshot({ points: [{ device_id: "a", seq: 1 }] }));
    expect(r.lost).toBe(2);
    expect(r.ok).toBe(false);
    expect(r.examples).toContain("lost a#2");
  });

  it("counts every extra copy of a (device, seq) row as a duplicate", () => {
    const points = [1, 2, 2, 3, 3, 3].map((seq) => ({ device_id: "a", seq }));
    const r = checkInvariants(delivered, snapshot({ points }));
    expect(r.duplicates).toBe(3);
    expect(r.lost).toBe(0);
    expect(r.ok).toBe(false);
  });

  it("flags rows the simulator never sent and duplicated trips", () => {
    const r = checkInvariants(
      delivered,
      snapshot({ points: [1, 2, 3, 99].map((seq) => ({ device_id: "a", seq })), trips: [trip(), trip()] }),
    );
    expect(r.phantom).toBe(1);
    expect(r.duplicateTrips).toBe(1);
    expect(r.ok).toBe(false);
  });

  it("reports trip, idle-segment and late-flag differences from the fault-free run", () => {
    const base = snapshot({ latePoints: [{ device_id: "a", seq: 2 }] });
    const run = snapshot({
      trips: [trip({ end_seq: 41, distance_m: 5400 })],
      idleSegments: [],
      latePoints: [],
    });
    const r = checkInvariants(delivered, run, base);
    expect(r.tripsMatch).toBe(false);
    expect(r.tripDiffs).toEqual([
      "trip a#10 end_seq: expected 40, got 41",
      "trip a#10 distance_m: expected 5321.123456789, got 5400",
      "idle segment a#20: expected t1|t2|75, got none",
      "late point a#2 missing",
    ]);
    expect(r.ok).toBe(false);
  });

  it("reports a different trip count", () => {
    const r = checkInvariants(delivered, snapshot({ trips: [] }), snapshot());
    expect(r.tripDiffs[0]).toBe("trip count: expected 1, got 0");
  });
});

describe("diffTrips", () => {
  it("ignores floating-point noise far below a millimetre but not real differences", () => {
    expect(diffTrips([trip()], [trip({ distance_m: 5321.123456789 + 1e-9 })])).toEqual([]);
    expect(diffTrips([trip()], [trip({ distance_m: 5321.13 })])).toHaveLength(1);
  });

  it("lists missing and unexpected trips", () => {
    expect(diffTrips([trip()], [trip({ start_seq: 11 })])).toEqual(["trip a#10 missing", "trip a#11 unexpected"]);
  });
});
