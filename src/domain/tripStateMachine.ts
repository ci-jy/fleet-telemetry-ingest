import { haversineM } from "./geo.js";

export type TripState = "parked" | "moving" | "idle" | "trip_ended";

/** Classification of a single message, plus the synthetic `gap` input for long silences. */
export type TripInput = "off" | "stationary" | "moving" | "gap";

export type EndReason = "ignition_off" | "gap" | "idle_timeout";

export interface TripConfig {
  /** Speeds at or above this (with ignition on) count as moving. */
  movingKph: number;
  /** A silence longer than this while moving or idle ends the trip at the last known point. */
  gapMs: number;
  /** Stationary periods shorter than this are not recorded as idle segments (traffic stops). */
  minIdleMs: number;
  /** An idle period this long ends the trip at the point where idling began. */
  maxIdleMs: number;
}

export const DEFAULT_TRIP_CONFIG: TripConfig = {
  movingKph: 3,
  gapMs: 5 * 60_000,
  minIdleMs: 60_000,
  maxIdleMs: 30 * 60_000,
};

export interface Point {
  seq: number;
  ts: number;
  lat: number;
  lon: number;
  speedKph: number;
  ignition: boolean;
}

export interface IdleSegment {
  startSeq: number;
  startTs: number;
  endTs: number;
  durationMs: number;
}

export interface OpenTrip {
  startSeq: number;
  startTs: number;
  startLat: number;
  startLon: number;
  distanceM: number;
  pointCount: number;
  maxSpeedKph: number;
  idleSegments: IdleSegment[];
  /** Set while idling: where idling began and the trip distance at that moment. */
  idleStart: { seq: number; ts: number; lat: number; lon: number; distanceM: number } | null;
}

export interface ClosedTrip {
  startSeq: number;
  endSeq: number;
  startTs: number;
  endTs: number;
  startLat: number;
  startLon: number;
  endLat: number;
  endLon: number;
  distanceM: number;
  durationMs: number;
  idleMs: number;
  pointCount: number;
  maxSpeedKph: number;
  endReason: EndReason;
  idleSegments: IdleSegment[];
}

export interface DeviceTripState {
  state: TripState;
  last: Point | null;
  trip: OpenTrip | null;
}

export interface Transition {
  from: TripState;
  input: TripInput;
  to: TripState;
  seq: number;
}

export type TripEvent =
  | { type: "trip_started"; seq: number; ts: number }
  | { type: "idle_started"; seq: number; ts: number }
  | { type: "idle_ended"; segment: IdleSegment; recorded: boolean }
  | { type: "trip_ended"; trip: ClosedTrip };

export interface StepResult {
  state: DeviceTripState;
  transitions: Transition[];
  events: TripEvent[];
}

export const initialTripState = (): DeviceTripState => ({ state: "parked", last: null, trip: null });

export function classify(p: Point, cfg: TripConfig): Exclude<TripInput, "gap"> {
  if (!p.ignition) return "off";
  return p.speedKph >= cfg.movingKph ? "moving" : "stationary";
}

/**
 * The complete transition table. Every (state, input) pair is listed; `step` asserts that the
 * transition it takes is in this table, and the unit tests exercise each row.
 */
export const TRANSITIONS: ReadonlyArray<{ from: TripState; input: TripInput; to: TripState; effect: string }> = [
  { from: "parked", input: "off", to: "parked", effect: "none" },
  { from: "parked", input: "stationary", to: "parked", effect: "none (engine on, not moving)" },
  { from: "parked", input: "moving", to: "moving", effect: "start trip (anchored at last known position)" },
  { from: "parked", input: "gap", to: "parked", effect: "none" },
  { from: "moving", input: "moving", to: "moving", effect: "accumulate distance" },
  { from: "moving", input: "stationary", to: "idle", effect: "start idle period" },
  { from: "moving", input: "off", to: "trip_ended", effect: "end trip (ignition_off)" },
  { from: "moving", input: "gap", to: "trip_ended", effect: "end trip at last point (gap), then re-evaluate message" },
  { from: "idle", input: "stationary", to: "idle", effect: "accumulate; if idle >= maxIdle end trip at idle start (idle_timeout) -> trip_ended" },
  { from: "idle", input: "moving", to: "moving", effect: "close idle period (recorded if >= minIdle)" },
  { from: "idle", input: "off", to: "trip_ended", effect: "close idle period, end trip (ignition_off)" },
  { from: "idle", input: "gap", to: "trip_ended", effect: "end trip at last point (gap), then re-evaluate message" },
  { from: "trip_ended", input: "moving", to: "moving", effect: "start new trip" },
  { from: "trip_ended", input: "stationary", to: "parked", effect: "none" },
  { from: "trip_ended", input: "off", to: "parked", effect: "none" },
  { from: "trip_ended", input: "gap", to: "trip_ended", effect: "none" },
];

const ALLOWED = new Set(TRANSITIONS.map((t) => `${t.from}|${t.input}|${t.to}`));
// idle + stationary may also end the trip on idle timeout.
ALLOWED.add("idle|stationary|trip_ended");

function openTrip(p: Point, anchor: Point | null): OpenTrip {
  const start = anchor ?? p;
  return {
    startSeq: p.seq,
    startTs: p.ts,
    startLat: start.lat,
    startLon: start.lon,
    distanceM: anchor ? haversineM(anchor, p) : 0,
    pointCount: 1,
    maxSpeedKph: p.speedKph,
    idleSegments: [],
    idleStart: null,
  };
}

function closeTrip(
  trip: OpenTrip,
  end: { seq: number; ts: number; lat: number; lon: number },
  distanceM: number,
  reason: EndReason,
): ClosedTrip {
  const idleMs = trip.idleSegments.reduce((acc, s) => acc + s.durationMs, 0);
  return {
    startSeq: trip.startSeq,
    endSeq: end.seq,
    startTs: trip.startTs,
    endTs: end.ts,
    startLat: trip.startLat,
    startLon: trip.startLon,
    endLat: end.lat,
    endLon: end.lon,
    distanceM,
    durationMs: Math.max(0, end.ts - trip.startTs),
    idleMs,
    pointCount: trip.pointCount,
    maxSpeedKph: trip.maxSpeedKph,
    endReason: reason,
    idleSegments: trip.idleSegments,
  };
}

/**
 * Advances one device's trip state by a single message. Messages must be supplied in ascending
 * `seq` order (the reorder buffer guarantees this); the function is pure, so replaying the same
 * ordered points always yields the same trips.
 */
export function step(prev: DeviceTripState, p: Point, cfg: TripConfig = DEFAULT_TRIP_CONFIG): StepResult {
  const transitions: Transition[] = [];
  const events: TripEvent[] = [];
  let state = prev.state;
  let last = prev.last;
  let trip: OpenTrip | null = prev.trip ? { ...prev.trip, idleSegments: [...prev.trip.idleSegments] } : null;

  const go = (input: TripInput, to: TripState): void => {
    if (!ALLOWED.has(`${state}|${input}|${to}`)) {
      throw new Error(`illegal transition ${state} --${input}--> ${to}`);
    }
    transitions.push({ from: state, input, to, seq: p.seq });
    state = to;
  };

  // 1. A long silence ends an active trip at the last point we saw.
  if (last && p.ts - last.ts > cfg.gapMs) {
    if ((state === "moving" || state === "idle") && trip) {
      events.push({ type: "trip_ended", trip: closeTrip(trip, last, trip.distanceM, "gap") });
      trip = null;
      go("gap", "trip_ended");
      // Do not anchor the next trip across the silence.
      last = null;
    } else {
      go("gap", state);
    }
  }

  // 2. The message itself.
  const input = classify(p, cfg);
  const legM = last ? haversineM(last, p) : 0;

  switch (state) {
    case "parked":
    case "trip_ended": {
      if (input === "moving") {
        trip = openTrip(p, last);
        events.push({ type: "trip_started", seq: p.seq, ts: p.ts });
        go(input, "moving");
      } else {
        go(input, "parked");
      }
      break;
    }
    case "moving": {
      if (!trip) throw new Error("moving without an open trip");
      trip.distanceM += legM;
      trip.pointCount += 1;
      trip.maxSpeedKph = Math.max(trip.maxSpeedKph, p.speedKph);
      if (input === "moving") {
        go(input, "moving");
      } else if (input === "stationary") {
        trip.idleStart = { seq: p.seq, ts: p.ts, lat: p.lat, lon: p.lon, distanceM: trip.distanceM };
        events.push({ type: "idle_started", seq: p.seq, ts: p.ts });
        go(input, "idle");
      } else {
        events.push({ type: "trip_ended", trip: closeTrip(trip, p, trip.distanceM, "ignition_off") });
        trip = null;
        go(input, "trip_ended");
      }
      break;
    }
    case "idle": {
      if (!trip || !trip.idleStart) throw new Error("idle without an open trip");
      const idleStart = trip.idleStart;
      if (input === "stationary" && p.ts - idleStart.ts >= cfg.maxIdleMs) {
        // Engine left running for too long: the trip really ended where idling began.
        events.push({
          type: "trip_ended",
          trip: closeTrip({ ...trip, idleStart: null }, idleStart, idleStart.distanceM, "idle_timeout"),
        });
        trip = null;
        go(input, "trip_ended");
        break;
      }
      trip.distanceM += legM;
      trip.pointCount += 1;
      trip.maxSpeedKph = Math.max(trip.maxSpeedKph, p.speedKph);
      if (input === "stationary") {
        go(input, "idle");
        break;
      }
      const segment: IdleSegment = {
        startSeq: idleStart.seq,
        startTs: idleStart.ts,
        endTs: p.ts,
        durationMs: Math.max(0, p.ts - idleStart.ts),
      };
      const recorded = segment.durationMs >= cfg.minIdleMs;
      if (recorded) trip.idleSegments.push(segment);
      trip.idleStart = null;
      events.push({ type: "idle_ended", segment, recorded });
      if (input === "moving") {
        go(input, "moving");
      } else {
        events.push({ type: "trip_ended", trip: closeTrip(trip, p, trip.distanceM, "ignition_off") });
        trip = null;
        go(input, "trip_ended");
      }
      break;
    }
  }

  return { state: { state, last: p, trip }, transitions, events };
}

/** Runs a full ordered sequence of points through the state machine (used for replay and tests). */
export function replay(
  points: Iterable<Point>,
  cfg: TripConfig = DEFAULT_TRIP_CONFIG,
  from: DeviceTripState = initialTripState(),
): { state: DeviceTripState; trips: ClosedTrip[]; transitions: Transition[] } {
  let s = from;
  const trips: ClosedTrip[] = [];
  const transitions: Transition[] = [];
  for (const p of points) {
    const r = step(s, p, cfg);
    s = r.state;
    transitions.push(...r.transitions);
    for (const e of r.events) if (e.type === "trip_ended") trips.push(e.trip);
  }
  return { state: s, trips, transitions };
}
