import mqtt, { type MqttClient } from "mqtt";
import type { Ingestor } from "./ingestor.js";

export interface SubscriberOptions {
  url: string;
  topic: string;
  clientId?: string;
}

/**
 * Subscribes to device telemetry with QoS 1 and hands every message to the ingestor.
 * A persistent session (clean: false) lets the broker queue messages while the service restarts;
 * redeliveries are harmless because storage is idempotent.
 */
export async function startSubscriber(ingestor: Ingestor, opts: SubscriberOptions): Promise<MqttClient> {
  const client = await mqtt.connectAsync(opts.url, {
    clientId: opts.clientId ?? "fleet-ingest",
    clean: false,
    reconnectPeriod: 1000,
    protocolVersion: 4,
  });
  client.on("message", (topic, payload) => {
    ingestor.submitRaw(topic, payload);
  });
  await client.subscribeAsync(opts.topic, { qos: 1 });
  return client;
}
