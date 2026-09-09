/**
 * Device-to-partition mapping for horizontally scaled ingestion.
 *
 * Every device id hashes to one of a fixed number of partitions, and the partition is carried in
 * the topic: `telemetry/p<partition>/<deviceId>`. Each partition is consumed by exactly one pod at
 * a time, so all messages of a device go through one reorder buffer and one state machine.
 * The partition count is fixed for the lifetime of the data; changing it re-maps devices.
 */

/** 32-bit FNV-1a over the UTF-8 bytes of the device id. Stable across processes and languages. */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(text, "utf8")) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function partitionOf(deviceId: string, partitions: number): number {
  if (!Number.isInteger(partitions) || partitions < 1) throw new Error(`partitions must be a positive integer, got ${partitions}`);
  return fnv1a32(deviceId) % partitions;
}

export const partitionTopic = (deviceId: string, partitions: number): string =>
  `telemetry/p${partitionOf(deviceId, partitions)}/${deviceId}`;

/** Subscription filter for one partition. */
export const partitionFilter = (partition: number): string => `telemetry/p${partition}/+`;

/** Fixed MQTT client id of a partition's persistent session (shared by whichever pod owns it). */
export const partitionClientId = (prefix: string, partition: number): string => `${prefix}-p${partition}`;

/** Parses `telemetry/p<k>/<deviceId>`; null if the topic is not a partitioned telemetry topic. */
export function parsePartitionTopic(topic: string): { partition: number; deviceId: string } | null {
  const parts = topic.split("/");
  if (parts.length !== 3 || parts[0] !== "telemetry" || !parts[2]) return null;
  const m = /^p(\d{1,5})$/.exec(parts[1]!);
  if (!m) return null;
  return { partition: Number(m[1]), deviceId: parts[2] };
}
