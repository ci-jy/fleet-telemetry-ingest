import { destinationPoint, haversineM, type LatLon } from "../domain/geo.js";
import type { Telemetry } from "../domain/telemetry.js";
import { Rng } from "./random.js";

export interface FleetConfig {
  seed: number;
  devices: number;
  tripsPerDevice: number;
  /** Event time of the first message (epoch ms). */
  startTs: number;
  /** Reporting interval while the ignition is on. */
  sampleMs: number;
  /** Reporting interval while parked with the ignition off. */
  heartbeatMs: number;
  /** Centre of the area vehicles start in. */
  origin: LatLon;
  devicePrefix: string;
}

export const DEFAULT_FLEET_CONFIG: FleetConfig = {
  seed: 42,
  devices: 20,
  tripsPerDevice: 4,
  startTs: Date.UTC(2026, 0, 5, 6, 0, 0),
  sampleMs: 5_000,
  heartbeatMs: 60_000,
  origin: { lat: 52.52, lon: 13.405 },
  devicePrefix: "veh",
};

export interface GroundTruthTrip {
  deviceId: string;
  startTs: number;
  endTs: number;
  /** Length of the driven polyline from the departure point to the parking point. */
  distanceM: number;
  /** Total duration of deliberate stops with the engine running (>= 2 minutes each). */
  idleMs: number;
  idleStops: number;
}

export interface SimulatedFleet {
  config: FleetConfig;
  /** Every message each device emitted, in true per-device order. */
  messages: Telemetry[];
  trips: GroundTruthTrip[];
}

/**
 * Generates a synthetic fleet with known trip boundaries. Each vehicle parks (ignition off,
 * heartbeat every minute), warms up, drives a random smooth route with short traffic stops and
 * a few deliberate idle stops, arrives, switches the ignition off and parks again.
 */
export function generateFleet(partial: Partial<FleetConfig> = {}): SimulatedFleet {
  const config: FleetConfig = { ...DEFAULT_FLEET_CONFIG, ...partial };
  const rng = new Rng(config.seed);
  const messages: Telemetry[] = [];
  const trips: GroundTruthTrip[] = [];

  for (let d = 0; d < config.devices; d++) {
    const deviceId = `${config.devicePrefix}-${String(d + 1).padStart(4, "0")}`;
    let seq = 1;
    let ts = config.startTs + rng.int(0, 120) * 1000;
    let pos = destinationPoint(config.origin, rng.range(0, 360), rng.range(0, 20_000));

    const emit = (speedKph: number, ignition: boolean): void => {
      messages.push({
        deviceId,
        seq: seq++,
        ts,
        lat: round6(pos.lat),
        lon: round6(pos.lon),
        speedKph: Math.round(speedKph * 10) / 10,
        ignition,
      });
    };
    const park = (minutes: number): void => {
      const beats = Math.max(1, Math.round((minutes * 60_000) / config.heartbeatMs));
      for (let i = 0; i < beats; i++) {
        ts += config.heartbeatMs;
        emit(0, false);
      }
    };

    park(rng.range(5, 15));
    for (let t = 0; t < config.tripsPerDevice; t++) {
      // Warm-up: engine on, not moving yet.
      for (let i = rng.int(1, 4); i > 0; i--) {
        ts += config.sampleMs;
        emit(0, true);
      }
      const startTs = ts + config.sampleMs;
      const track: LatLon[] = [{ ...pos }];
      let heading = rng.range(0, 360);
      let speed = rng.range(20, 40);
      const driveSamples = rng.int(60, 360); // 5–30 minutes of driving
      const idleAt = new Set<number>();
      for (let k = rng.int(0, 2); k > 0; k--) idleAt.add(rng.int(10, driveSamples - 10));
      let idleMs = 0;

      for (let i = 0; i < driveSamples; i++) {
        if (idleAt.has(i)) {
          // Deliberate stop with the engine running (delivery, pick-up): 2–6 minutes.
          const stopSamples = Math.round((rng.range(2, 6) * 60_000) / config.sampleMs);
          const stopStart = ts + config.sampleMs;
          for (let j = 0; j < stopSamples; j++) {
            ts += config.sampleMs;
            emit(0, true);
          }
          idleMs += ts + config.sampleMs - stopStart; // ends when the next moving sample arrives
          speed = rng.range(10, 25);
        } else if (rng.chance(0.01)) {
          // Short traffic stop, well under the idle threshold.
          for (let j = rng.int(1, 3); j > 0; j--) {
            ts += config.sampleMs;
            emit(0, true);
          }
          speed = rng.range(10, 20);
        }
        heading = (heading + rng.range(-12, 12) + 360) % 360;
        speed = clamp(speed + rng.range(-6, 6), 15, 95);
        ts += config.sampleMs;
        pos = destinationPoint(pos, heading, (speed / 3.6) * (config.sampleMs / 1000));
        track.push({ ...pos });
        emit(speed, true);
      }
      // Arrive, then switch the ignition off.
      ts += config.sampleMs;
      emit(0, true);
      ts += config.sampleMs;
      emit(0, false);
      trips.push({
        deviceId,
        startTs,
        endTs: ts,
        distanceM: polyline(track.map((p) => ({ lat: round6(p.lat), lon: round6(p.lon) }))),
        idleMs,
        idleStops: idleAt.size,
      });
      park(rng.range(10, 60));
    }
  }
  return { config, messages, trips };
}

export interface FaultConfig {
  seed: number;
  /** Probability a message is never delivered. */
  dropRate: number;
  /** Probability a device suffers a connectivity outage starting at a given message. */
  outageRate: number;
  /** Outage length bounds; must stay below the trip gap timeout. */
  outageMs: [number, number];
  /** Probability a message is delivered twice. */
  duplicateRate: number;
  /** Probability a message is delayed (delivered out of order). */
  reorderRate: number;
  /** Maximum extra delay for reordered messages; keep below the reorder window. */
  maxReorderDelayMs: number;
  /** Probability a message arrives after the reorder window has given up on it. */
  lateRate: number;
  lateDelayMs: number;
}

export const DEFAULT_FAULTS: FaultConfig = {
  seed: 7,
  dropRate: 0.02,
  outageRate: 0.002,
  outageMs: [30_000, 120_000],
  duplicateRate: 0.05,
  reorderRate: 0.1,
  maxReorderDelayMs: 20_000,
  lateRate: 0.002,
  lateDelayMs: 90_000,
};

export interface Delivery {
  deliverAt: number;
  msg: Telemetry;
  kind: "original" | "duplicate";
}

export interface FaultStats {
  emitted: number;
  dropped: number;
  duplicates: number;
  reordered: number;
  late: number;
}

/**
 * Turns a perfect message stream into what an unreliable link would deliver: drops and outages
 * remove messages (their sequence numbers stay consumed), some messages are delayed so they
 * arrive out of order, a few arrive very late, and some arrive twice. The result is sorted by
 * simulated delivery time.
 */
export function injectFaults(
  messages: readonly Telemetry[],
  partial: Partial<FaultConfig> = {},
): { deliveries: Delivery[]; stats: FaultStats } {
  const f: FaultConfig = { ...DEFAULT_FAULTS, ...partial };
  const rng = new Rng(f.seed);
  const deliveries: Delivery[] = [];
  const stats: FaultStats = { emitted: messages.length, dropped: 0, duplicates: 0, reordered: 0, late: 0 };
  const outageUntil = new Map<string, number>();

  for (const msg of messages) {
    const until = outageUntil.get(msg.deviceId) ?? 0;
    if (msg.ts < until) {
      stats.dropped++;
      continue;
    }
    if (rng.chance(f.outageRate)) {
      outageUntil.set(msg.deviceId, msg.ts + rng.range(f.outageMs[0], f.outageMs[1]));
      stats.dropped++;
      continue;
    }
    if (rng.chance(f.dropRate)) {
      stats.dropped++;
      continue;
    }
    const base = msg.ts + 200;
    let deliverAt = base;
    if (rng.chance(f.lateRate)) {
      deliverAt += f.lateDelayMs;
      stats.late++;
    } else if (rng.chance(f.reorderRate)) {
      deliverAt += rng.range(1_000, f.maxReorderDelayMs);
      stats.reordered++;
    }
    deliveries.push({ deliverAt, msg, kind: "original" });
    if (rng.chance(f.duplicateRate)) {
      deliveries.push({ deliverAt: deliverAt + rng.range(0, 120_000), msg: { ...msg }, kind: "duplicate" });
      stats.duplicates++;
    }
  }
  deliveries.sort((a, b) => a.deliverAt - b.deliverAt);
  return { deliveries, stats };
}

function polyline(points: LatLon[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += haversineM(points[i - 1]!, points[i]!);
  return total;
}

const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
