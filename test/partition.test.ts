import { describe, expect, it } from "vitest";
import {
  fnv1a32,
  parsePartitionTopic,
  partitionClientId,
  partitionFilter,
  partitionOf,
  partitionTopic,
} from "../src/cluster/partition.js";
import { deviceIdFromTopic, parseTelemetry } from "../src/domain/telemetry.js";

const msg = (deviceId: string) =>
  JSON.stringify({ deviceId, seq: 1, ts: 1767600000000, lat: 52.5, lon: 13.4, speedKph: 0, ignition: false });

describe("partition hashing", () => {
  it("uses 32-bit FNV-1a (reference vectors)", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
    expect(fnv1a32("foobar")).toBe(0xbf9cf968);
  });

  it("is deterministic and within range", () => {
    for (let i = 0; i < 500; i++) {
      const id = `veh-${String(i).padStart(4, "0")}`;
      const p = partitionOf(id, 16);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(16);
      expect(partitionOf(id, 16)).toBe(p);
    }
  });

  it("spreads a 200-vehicle fleet over 16 partitions without empty or crowded partitions", () => {
    const counts = new Array<number>(16).fill(0);
    for (let i = 0; i < 200; i++) counts[partitionOf(`veh-${String(i + 1).padStart(4, "0")}`, 16)]!++;
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(5);
    expect(Math.max(...counts)).toBeLessThanOrEqual(25);
  });

  it("rejects an invalid partition count", () => {
    expect(() => partitionOf("x", 0)).toThrow();
    expect(() => partitionOf("x", 2.5)).toThrow();
  });
});

describe("partitioned topics", () => {
  it("round-trips device and partition through the topic", () => {
    const t = partitionTopic("veh-0042", 16);
    expect(t).toBe(`telemetry/p${partitionOf("veh-0042", 16)}/veh-0042`);
    expect(parsePartitionTopic(t)).toEqual({ partition: partitionOf("veh-0042", 16), deviceId: "veh-0042" });
    expect(deviceIdFromTopic(t)).toBe("veh-0042");
    expect(partitionFilter(3)).toBe("telemetry/p3/+");
    expect(partitionClientId("fleet-ingest", 3)).toBe("fleet-ingest-p3");
  });

  it("ignores malformed partition topics", () => {
    expect(parsePartitionTopic("telemetry/3/veh-1")).toBeNull();
    expect(parsePartitionTopic("telemetry/p3/")).toBeNull();
    expect(parsePartitionTopic("telemetry/p3/veh-1/x")).toBeNull();
    expect(parsePartitionTopic("fleet/veh-1/telemetry")).toBeNull();
  });

  it("accepts a message on its own partition and rejects it on another", () => {
    const own = partitionOf("veh-0007", 16);
    expect(parseTelemetry(`telemetry/p${own}/veh-0007`, msg("veh-0007"), 16).ok).toBe(true);
    const wrong = parseTelemetry(`telemetry/p${(own + 1) % 16}/veh-0007`, msg("veh-0007"), 16);
    expect(wrong.ok).toBe(false);
    // The single-instance topic layout keeps working.
    expect(parseTelemetry("fleet/veh-0007/telemetry", msg("veh-0007"), 16).ok).toBe(true);
  });
});
