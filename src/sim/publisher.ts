import type { MqttClient } from "mqtt";
import { topicFor, type Telemetry } from "../domain/telemetry.js";

/**
 * Publishes messages in the given order on one connection (QoS 1). MQTT keeps per-connection
 * ordering, so the subscriber sees exactly the simulated delivery order. At most `inflight`
 * publishes are outstanding at a time.
 */
export async function publishAll(
  client: MqttClient,
  messages: Iterable<Telemetry>,
  opts: { inflight?: number; onPublished?: (msg: Telemetry) => void } = {},
): Promise<number> {
  const inflight = opts.inflight ?? 500;
  const outstanding = new Set<Promise<void>>();
  let n = 0;
  for (const msg of messages) {
    const p: Promise<void> = client
      .publishAsync(topicFor(msg.deviceId), JSON.stringify(msg), { qos: 1 })
      .then(() => {
        outstanding.delete(p);
      });
    outstanding.add(p);
    opts.onPublished?.(msg);
    n++;
    if (outstanding.size >= inflight) await Promise.race(outstanding);
  }
  await Promise.all(outstanding);
  return n;
}
