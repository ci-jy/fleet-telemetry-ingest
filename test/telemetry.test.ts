import { describe, expect, it } from "vitest";
import { deviceIdFromTopic, parseTelemetry } from "../src/domain/telemetry.js";

const good = { deviceId: "veh-1", seq: 3, ts: 1767600000000, lat: 52.5, lon: 13.4, speedKph: 42.5, ignition: true };

describe("telemetry parsing", () => {
  it("accepts a valid message on the matching topic", () => {
    expect(parseTelemetry("fleet/veh-1/telemetry", JSON.stringify(good))).toEqual({ ok: true, msg: good });
  });

  it.each([
    ["bad JSON", "fleet/veh-1/telemetry", "{"],
    ["topic mismatch", "fleet/veh-2/telemetry", JSON.stringify(good)],
    ["wrong topic shape", "fleet/veh-1/status", JSON.stringify(good)],
    ["negative seq", "fleet/veh-1/telemetry", JSON.stringify({ ...good, seq: -1 })],
    ["fractional seq", "fleet/veh-1/telemetry", JSON.stringify({ ...good, seq: 1.5 })],
    ["latitude out of range", "fleet/veh-1/telemetry", JSON.stringify({ ...good, lat: 91 })],
    ["missing ignition", "fleet/veh-1/telemetry", JSON.stringify({ ...good, ignition: undefined })],
    ["string speed", "fleet/veh-1/telemetry", JSON.stringify({ ...good, speedKph: "10" })],
    ["unknown field", "fleet/veh-1/telemetry", JSON.stringify({ ...good, extra: 1 })],
  ])("rejects %s", (_name, topic, payload) => {
    expect(parseTelemetry(topic, payload).ok).toBe(false);
  });

  it("extracts device ids from topics", () => {
    expect(deviceIdFromTopic("fleet/abc/telemetry")).toBe("abc");
    expect(deviceIdFromTopic("fleet//telemetry")).toBeNull();
    expect(deviceIdFromTopic("x/abc/telemetry")).toBeNull();
  });
});
