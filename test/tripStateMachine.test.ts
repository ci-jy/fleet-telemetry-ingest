import { describe, expect, it } from "vitest";
import { destinationPoint, haversineM } from "../src/domain/geo.js";
import { ReorderBuffer } from "../src/domain/reorderBuffer.js";
import type { Telemetry } from "../src/domain/telemetry.js";
import {
  DEFAULT_TRIP_CONFIG as CFG,
  TRANSITIONS,
  classify,
  initialTripState,
  replay,
  step,
  type DeviceTripState,
  type Point,
  type Transition,
  type TripEvent,
} from "../src/domain/tripStateMachine.js";

const T0 = Date.UTC(2026, 0, 1, 8, 0, 0);
const ORIGIN = { lat: 48.137, lon: 11.575 };

/** Builds points 5 s apart moving east by `speed` km/h, with explicit overrides. */
class Track {
  seq = 0;
  ts = T0;
  pos = { ...ORIGIN };
  readonly points: Point[] = [];
  add(kind: "off" | "stationary" | "moving", opts: { dtMs?: number; speedKph?: number } = {}): Point {
    const dtMs = opts.dtMs ?? 5_000;
    this.ts += dtMs;
    const speedKph = kind === "moving" ? (opts.speedKph ?? 36) : 0;
    if (kind === "moving") this.pos = destinationPoint(this.pos, 90, (speedKph / 3.6) * (dtMs / 1000));
    const p: Point = {
      seq: ++this.seq,
      ts: this.ts,
      lat: this.pos.lat,
      lon: this.pos.lon,
      speedKph,
      ignition: kind !== "off",
    };
    this.points.push(p);
    return p;
  }
  many(kind: "off" | "stationary" | "moving", n: number, opts?: { dtMs?: number }): void {
    for (let i = 0; i < n; i++) this.add(kind, opts);
  }
}

function run(points: Point[], from: DeviceTripState = initialTripState()) {
  let s = from;
  const transitions: Transition[] = [];
  const events: TripEvent[] = [];
  for (const p of points) {
    const r = step(s, p, CFG);
    s = r.state;
    transitions.push(...r.transitions);
    events.push(...r.events);
  }
  return { state: s, transitions, events, trips: events.flatMap((e) => (e.type === "trip_ended" ? [e.trip] : [])) };
}

const covered = new Set<string>();
const record = (ts: Transition[]) => ts.forEach((t) => covered.add(`${t.from}|${t.input}|${t.to}`));

describe("classify", () => {
  const base = { seq: 1, ts: T0, lat: 0, lon: 0 };
  it("treats ignition off as off regardless of speed", () => {
    expect(classify({ ...base, speedKph: 50, ignition: false }, CFG)).toBe("off");
  });
  it("splits ignition-on messages on the moving threshold", () => {
    expect(classify({ ...base, speedKph: CFG.movingKph - 0.1, ignition: true }, CFG)).toBe("stationary");
    expect(classify({ ...base, speedKph: CFG.movingKph, ignition: true }, CFG)).toBe("moving");
  });
});

describe("trip state machine transitions", () => {
  it("parked stays parked on off, stationary and gap", () => {
    const t = new Track();
    t.add("off");
    t.add("stationary");
    t.add("off", { dtMs: CFG.gapMs + 60_000 });
    const r = run(t.points);
    record(r.transitions);
    expect(r.transitions.map((x) => `${x.from}>${x.input}>${x.to}`)).toEqual([
      "parked>off>parked",
      "parked>stationary>parked",
      "parked>gap>parked",
      "parked>off>parked",
    ]);
    expect(r.trips).toHaveLength(0);
  });

  it("parked -> moving starts a trip anchored at the last parked position", () => {
    const t = new Track();
    t.add("off");
    const anchor = t.points[0]!;
    const first = t.add("moving");
    const r = run(t.points);
    record(r.transitions);
    expect(r.state.state).toBe("moving");
    expect(r.events).toContainEqual({ type: "trip_started", seq: first.seq, ts: first.ts });
    expect(r.state.trip!.startLat).toBe(anchor.lat);
    expect(r.state.trip!.distanceM).toBeCloseTo(haversineM(anchor, first), 6);
  });

  it("moving -> moving accumulates haversine distance", () => {
    const t = new Track();
    t.add("off");
    t.many("moving", 10);
    const r = run(t.points);
    record(r.transitions);
    let expected = 0;
    for (let i = 1; i < t.points.length; i++) expected += haversineM(t.points[i - 1]!, t.points[i]!);
    expect(r.state.trip!.distanceM).toBeCloseTo(expected, 6);
    expect(r.state.trip!.pointCount).toBe(10);
  });

  it("moving -> off ends the trip with reason ignition_off", () => {
    const t = new Track();
    t.add("off");
    t.many("moving", 5);
    const end = t.add("off");
    const r = run(t.points);
    record(r.transitions);
    expect(r.state.state).toBe("trip_ended");
    expect(r.trips).toHaveLength(1);
    const trip = r.trips[0]!;
    expect(trip.endReason).toBe("ignition_off");
    expect(trip.endSeq).toBe(end.seq);
    expect(trip.startSeq).toBe(2);
    expect(trip.durationMs).toBe(end.ts - t.points[1]!.ts);
    expect(trip.idleMs).toBe(0);
  });

  it("moving -> idle -> moving records an idle segment of at least minIdle", () => {
    const t = new Track();
    t.add("off");
    t.many("moving", 3);
    const idleStart = t.add("stationary");
    t.many("stationary", 20); // 100 s
    const resume = t.add("moving");
    t.add("off");
    const r = run(t.points);
    record(r.transitions);
    expect(r.events.filter((e) => e.type === "idle_started")).toHaveLength(1);
    const trip = r.trips[0]!;
    expect(trip.idleSegments).toEqual([
      { startSeq: idleStart.seq, startTs: idleStart.ts, endTs: resume.ts, durationMs: resume.ts - idleStart.ts },
    ]);
    expect(trip.idleMs).toBe(105_000);
  });

  it("short stops below minIdle are not recorded as idle segments", () => {
    const t = new Track();
    t.add("off");
    t.many("moving", 3);
    t.many("stationary", 3);
    t.many("moving", 3);
    t.add("off");
    const r = run(t.points);
    const ended = r.events.find((e) => e.type === "idle_ended");
    expect(ended).toMatchObject({ type: "idle_ended", recorded: false });
    expect(r.trips[0]!.idleSegments).toEqual([]);
    expect(r.trips[0]!.idleMs).toBe(0);
  });

  it("idle -> off closes the idle segment and ends the trip", () => {
    const t = new Track();
    t.add("off");
    t.many("moving", 3);
    t.many("stationary", 15);
    t.add("off");
    const r = run(t.points);
    record(r.transitions);
    expect(r.transitions.at(-1)).toMatchObject({ from: "idle", input: "off", to: "trip_ended" });
    expect(r.trips[0]!.idleSegments).toHaveLength(1);
    expect(r.trips[0]!.endReason).toBe("ignition_off");
  });

  it("idle for maxIdle ends the trip where idling began (idle_timeout)", () => {
    const t = new Track();
    t.add("off");
    t.many("moving", 4);
    const distBefore = run(t.points).state.trip!.distanceM;
    const idleStart = t.add("stationary");
    t.many("stationary", CFG.maxIdleMs / 60_000, { dtMs: 60_000 });
    const r = run(t.points);
    record(r.transitions);
    expect(r.trips).toHaveLength(1);
    const trip = r.trips[0]!;
    expect(trip.endReason).toBe("idle_timeout");
    expect(trip.endSeq).toBe(idleStart.seq);
    expect(trip.endTs).toBe(idleStart.ts);
    expect(trip.distanceM).toBeCloseTo(distBefore + haversineM(t.points[4]!, idleStart), 6);
    expect(trip.idleSegments).toEqual([]);
    // Still idling afterwards: trip_ended -> parked, no new trip.
    t.add("stationary");
    const after = run(t.points);
    record(after.transitions);
    expect(after.state.state).toBe("parked");
    expect(after.trips).toHaveLength(1);
  });

  it("a gap while moving ends the trip at the last point, then re-evaluates the message", () => {
    const t = new Track();
    t.add("off");
    t.many("moving", 5);
    const lastBefore = t.points.at(-1)!;
    const afterGap = t.add("moving", { dtMs: CFG.gapMs + 1 });
    const r = run(t.points);
    record(r.transitions);
    expect(r.trips).toHaveLength(1);
    expect(r.trips[0]).toMatchObject({ endReason: "gap", endSeq: lastBefore.seq, endTs: lastBefore.ts });
    expect(r.transitions.slice(-2).map((x) => `${x.from}>${x.input}>${x.to}`)).toEqual([
      "moving>gap>trip_ended",
      "trip_ended>moving>moving",
    ]);
    // The new trip is not anchored across the silence.
    expect(r.state.trip!.startSeq).toBe(afterGap.seq);
    expect(r.state.trip!.distanceM).toBe(0);
  });

  it("a gap exactly equal to gapMs does not end the trip", () => {
    const t = new Track();
    t.add("off");
    t.many("moving", 2);
    t.add("moving", { dtMs: CFG.gapMs });
    const r = run(t.points);
    expect(r.trips).toHaveLength(0);
    expect(r.state.state).toBe("moving");
  });

  it("a gap while idle ends the trip (gap) and drops the unfinished idle period", () => {
    const t = new Track();
    t.add("off");
    t.many("moving", 3);
    t.many("stationary", 3);
    t.add("off", { dtMs: CFG.gapMs + 1 });
    const r = run(t.points);
    record(r.transitions);
    expect(r.transitions.slice(-2).map((x) => `${x.from}>${x.input}>${x.to}`)).toEqual([
      "idle>gap>trip_ended",
      "trip_ended>off>parked",
    ]);
    expect(r.trips[0]!.endReason).toBe("gap");
    expect(r.trips[0]!.idleSegments).toEqual([]);
  });

  it("trip_ended -> moving starts a new trip; stationary/off park the vehicle", () => {
    for (const [kind, to] of [
      ["moving", "moving"],
      ["stationary", "parked"],
      ["off", "parked"],
    ] as const) {
      const t = new Track();
      t.add("off");
      t.many("moving", 2);
      t.add("off");
      t.add(kind);
      const r = run(t.points);
      record(r.transitions);
      expect(r.transitions.at(-1)).toMatchObject({ from: "trip_ended", input: kind, to });
      expect(r.events.filter((e) => e.type === "trip_started")).toHaveLength(kind === "moving" ? 2 : 1);
    }
  });

  it("trip_ended stays trip_ended on a gap", () => {
    const t = new Track();
    t.add("off");
    t.many("moving", 2);
    t.add("off");
    t.add("moving", { dtMs: CFG.gapMs + 10_000 });
    const r = run(t.points);
    record(r.transitions);
    expect(r.transitions.slice(-2).map((x) => `${x.from}>${x.input}>${x.to}`)).toEqual([
      "trip_ended>gap>trip_ended",
      "trip_ended>moving>moving",
    ]);
  });

  it("the first message of a device can start a trip without an anchor", () => {
    const t = new Track();
    t.add("moving");
    const r = run(t.points);
    expect(r.state.state).toBe("moving");
    expect(r.state.trip!.distanceM).toBe(0);
  });

  it("step does not mutate its input state", () => {
    const t = new Track();
    t.add("off");
    t.many("moving", 3);
    const s = run(t.points).state;
    const frozen = JSON.stringify(s);
    step(s, t.add("stationary"), CFG);
    step(s, t.add("off"), CFG);
    expect(JSON.stringify(s)).toBe(frozen);
  });

  it("replay of the same points is deterministic", () => {
    const t = new Track();
    t.add("off");
    t.many("moving", 20);
    t.many("stationary", 20);
    t.many("moving", 20);
    t.add("off");
    t.many("off", 5, { dtMs: 60_000 });
    t.many("moving", 10);
    t.add("off");
    expect(replay(t.points, CFG)).toEqual(replay(t.points, CFG));
    expect(replay(t.points, CFG).trips).toHaveLength(2);
  });

  it("covers every row of the transition table", () => {
    // Runs after the tests above (same file, sequential).
    const table = TRANSITIONS.map((t) => `${t.from}|${t.input}|${t.to}`);
    const missing = table.filter((k) => !covered.has(k));
    expect(missing).toEqual([]);
  });
});

describe("late and duplicate messages (reorder buffer + state machine)", () => {
  const toMsg = (p: Point): Telemetry => ({ deviceId: "dev-1", ...p });

  function feed(order: Point[], windowMs = 30_000) {
    const buf = new ReorderBuffer({ windowMs, maxBuffered: 100 });
    const applied: Point[] = [];
    const outcomes: string[] = [];
    for (const p of order) {
      const r = buf.offer(toMsg(p));
      outcomes.push(r.outcome);
      applied.push(...r.released);
    }
    applied.push(...buf.flush());
    return { applied, outcomes, result: replay(applied, CFG) };
  }

  const trackWithIdle = () => {
    const t = new Track();
    t.add("off");
    t.many("moving", 6);
    t.many("stationary", 14);
    t.many("moving", 6);
    t.add("off");
    t.many("off", 3, { dtMs: 60_000 });
    return t.points;
  };

  it("out-of-order delivery within the window yields the same trip as in-order delivery", () => {
    const pts = trackWithIdle();
    const inOrder = replay(pts, CFG).trips;
    const shuffled = [...pts];
    // Swap neighbours throughout, including the ignition-off and idle boundaries.
    for (let i = 1; i + 1 < shuffled.length; i += 3) [shuffled[i], shuffled[i + 1]] = [shuffled[i + 1]!, shuffled[i]!];
    const r = feed(shuffled);
    expect(r.applied.map((p) => p.seq)).toEqual(pts.map((p) => p.seq));
    expect(r.result.trips).toEqual(inOrder);
  });

  it("duplicates are rejected and do not double-count distance", () => {
    const pts = trackWithIdle();
    const withDups = pts.flatMap((p, i) => (i % 2 === 0 ? [p, { ...p }] : [p]));
    const r = feed(withDups);
    expect(r.outcomes.filter((o) => o === "duplicate")).toHaveLength(Math.ceil(pts.length / 2));
    expect(r.result.trips).toEqual(replay(pts, CFG).trips);
  });

  it("a message arriving after the window is reported late and not applied", () => {
    const pts = trackWithIdle();
    const lateOne = pts[4]!; // a moving point mid-trip
    const order = pts.filter((p) => p !== lateOne);
    order.push(lateOne);
    const r = feed(order, 10_000);
    expect(r.outcomes.at(-1)).toBe("late");
    expect(r.applied.map((p) => p.seq)).not.toContain(lateOne.seq);
    expect(r.result.trips).toHaveLength(1);
    // The trip loses only the detour through the late point.
    const full = replay(pts, CFG).trips[0]!.distanceM;
    expect(r.result.trips[0]!.distanceM).toBeLessThanOrEqual(full + 1e-6);
    expect(r.result.trips[0]!.distanceM).toBeGreaterThan(full * 0.99);
  });

  it("a late ignition-off still ends the trip on the next ignition-off heartbeat", () => {
    const pts = trackWithIdle();
    const offIdx = pts.findIndex((p, i) => i > 0 && !p.ignition);
    const off = pts[offIdx]!;
    const order = pts.filter((p) => p !== off);
    order.push(off);
    const r = feed(order, 10_000);
    expect(r.outcomes.at(-1)).toBe("late");
    expect(r.result.trips).toHaveLength(1);
    expect(r.result.trips[0]!.endSeq).toBe(pts[offIdx + 1]!.seq);
  });

  it("a duplicate of a late message is a duplicate, not late twice", () => {
    const pts = trackWithIdle();
    const lateOne = pts[4]!;
    const order = pts.filter((p) => p !== lateOne);
    order.push(lateOne, { ...lateOne });
    const r = feed(order, 10_000);
    expect(r.outcomes.slice(-2)).toEqual(["late", "duplicate"]);
  });
});
