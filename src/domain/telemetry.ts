import { z } from "zod";
import { parsePartitionTopic, partitionOf } from "../cluster/partition.js";

/**
 * Wire format of a telemetry message published on `fleet/<deviceId>/telemetry`.
 * `seq` is a per-device, strictly increasing counter assigned by the device; it is
 * the idempotency key together with `deviceId`.
 */
export const telemetrySchema = z
  .object({
    deviceId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_.-]+$/, "deviceId may only contain letters, digits, '_', '.', '-'"),
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ts: z.number().int().positive(), // device event time, epoch milliseconds
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    speedKph: z.number().min(0).max(400),
    ignition: z.boolean(),
  })
  .strict();

export type Telemetry = z.infer<typeof telemetrySchema>;

export const TOPIC_FILTER = "fleet/+/telemetry";

/**
 * Extracts the device id from a `fleet/<deviceId>/telemetry` topic or a partitioned
 * `telemetry/p<partition>/<deviceId>` topic, or null if it matches neither.
 */
export function deviceIdFromTopic(topic: string): string | null {
  const partitioned = parsePartitionTopic(topic);
  if (partitioned) return partitioned.deviceId;
  const parts = topic.split("/");
  if (parts.length !== 3 || parts[0] !== "fleet" || parts[2] !== "telemetry" || !parts[1]) {
    return null;
  }
  return parts[1];
}

export type ParseResult =
  | { ok: true; msg: Telemetry }
  | { ok: false; error: string };

/**
 * Parses and validates a raw MQTT payload; the topic's device id must match the payload's. With
 * `partitions` set, a partitioned topic must also name the partition the device hashes to, so a
 * misrouted publish cannot split one device across two owners.
 */
export function parseTelemetry(topic: string, payload: Buffer | string, partitions?: number): ParseResult {
  const topicDevice = deviceIdFromTopic(topic);
  if (topicDevice === null) return { ok: false, error: `unexpected topic ${topic}` };
  if (partitions !== undefined) {
    const p = parsePartitionTopic(topic);
    if (p && p.partition !== partitionOf(topicDevice, partitions)) {
      return { ok: false, error: `device ${topicDevice} belongs to partition ${partitionOf(topicDevice, partitions)}, not ${p.partition}` };
    }
  }
  let json: unknown;
  try {
    json = JSON.parse(typeof payload === "string" ? payload : payload.toString("utf8"));
  } catch {
    return { ok: false, error: "payload is not valid JSON" };
  }
  const parsed = telemetrySchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  if (parsed.data.deviceId !== topicDevice) {
    return { ok: false, error: `deviceId ${parsed.data.deviceId} does not match topic ${topic}` };
  }
  return { ok: true, msg: parsed.data };
}

export const topicFor = (deviceId: string): string => `fleet/${deviceId}/telemetry`;
