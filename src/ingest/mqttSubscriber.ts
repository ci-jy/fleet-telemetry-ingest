import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import type { Ingestor } from "./ingestor.js";

export interface SubscriberOptions {
  url: string;
  topic: string;
  clientId?: string;
  /** First reconnect delay; doubles on each failed attempt... */
  reconnectMinMs?: number;
  /** ...up to this cap. */
  reconnectMaxMs?: number;
  keepaliveS?: number;
  /** Give up if the first connection is not up within this time. */
  connectDeadlineMs?: number;
  log?: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
}

export interface SubscriberStats {
  connected: boolean;
  connects: number;
  disconnects: number;
  /** Acknowledgements dropped because the connection they belonged to is gone. */
  staleAcks: number;
}

type SendPacket = (packet: { cmd: string; messageId?: number }, cb?: (err?: Error) => void, ...rest: unknown[]) => void;

/**
 * Subscribes to device telemetry with QoS 1 and hands every message to the ingestor.
 *
 * Delivery is at-least-once end to end:
 * - The session is persistent (clean: false, fixed client id), so the broker keeps queued and
 *   unacknowledged messages while the service is down or reconnecting.
 * - A message's PUBACK is sent only after the batch containing it has committed. If the process
 *   dies first, the broker still holds the message and redelivers it on the next connection;
 *   storage is idempotent, so a redelivery is harmless.
 * - When the ingestor's queue is full the client stops reading from the socket until it has
 *   drained (backpressure through TCP to the broker, which queues for the session).
 * - Reconnects back off exponentially from `reconnectMinMs` to `reconnectMaxMs`.
 */
export async function startSubscriber(
  ingestor: Ingestor,
  opts: SubscriberOptions,
): Promise<MqttClient & { subscriberStats: SubscriberStats }> {
  const minMs = opts.reconnectMinMs ?? 250;
  const maxMs = opts.reconnectMaxMs ?? 5_000;
  const log = opts.log ?? (() => undefined);
  const options: IClientOptions = {
    clientId: opts.clientId ?? "fleet-ingest",
    clean: false,
    reconnectPeriod: minMs,
    connectTimeout: 5_000,
    keepalive: opts.keepaliveS ?? 30,
    protocolVersion: 4,
    manualConnect: true,
  };
  const client = mqtt.connect(opts.url, options) as MqttClient & { subscriberStats: SubscriberStats };
  const stats: SubscriberStats = { connected: false, connects: 0, disconnects: 0, staleAcks: 0 };
  client.subscriberStats = stats;

  // PUBACKs are written by us after commit. mqtt.js writes one as soon as `handleMessage` calls
  // back; message ids in this set have that automatic PUBACK suppressed.
  const internal = client as unknown as { _sendPacket: SendPacket };
  const send: SendPacket = internal._sendPacket.bind(client);
  const deferred = new Set<number>();
  internal._sendPacket = (packet, cb, ...rest) => {
    if (packet.cmd === "puback" && packet.messageId !== undefined && deferred.delete(packet.messageId)) {
      cb?.();
      return;
    }
    send(packet, cb, ...rest);
  };

  let generation = 0;
  let failures = 0;
  client.on("connect", (connack) => {
    generation++;
    failures = 0;
    stats.connects++;
    stats.connected = true;
    client.options.reconnectPeriod = minMs;
    ingestor.setSourceConnected(true);
    log("info", "mqtt connected", { sessionPresent: connack.sessionPresent, connects: stats.connects });
  });
  client.on("close", () => {
    if (stats.connected) {
      stats.disconnects++;
      log("warn", "mqtt connection lost");
    }
    stats.connected = false;
    ingestor.setSourceConnected(false);
    client.options.reconnectPeriod = Math.min(maxMs, minMs * 2 ** Math.min(failures, 16));
    failures++;
  });
  client.on("error", (err) => log("warn", "mqtt error", { error: err.message }));

  client.handleMessage = (packet, callback) => {
    if (ingestor.isClosed) return; // shutting down: never acknowledged, so the broker redelivers it
    const id = packet.messageId;
    let ack: (() => void) | undefined;
    if (packet.qos === 1 && id !== undefined) {
      deferred.add(id);
      const gen = generation;
      ack = () => {
        // An id is only meaningful on the connection that delivered it; after a reconnect the
        // broker resends the message and the new copy is acknowledged on its own.
        if (gen !== generation || !client.connected) {
          stats.staleAcks++;
          return;
        }
        send({ cmd: "puback", messageId: id });
      };
    }
    ingestor.submitRaw(packet.topic, packet.payload as Buffer, ack);
    if (ingestor.saturated) void ingestor.whenReady().then(() => callback());
    else callback();
  };

  // The first connection also retries with backoff (the broker may still be starting), but only
  // for a bounded time so a misconfigured URL fails the start instead of hanging.
  const deadlineMs = opts.connectDeadlineMs ?? 30_000;
  const connected = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("connect", onConnect);
      client.end(true);
      reject(new Error(`could not connect to ${opts.url} within ${deadlineMs} ms`));
    }, deadlineMs);
    const onConnect = () => {
      clearTimeout(timer);
      resolve();
    };
    client.once("connect", onConnect);
  });
  client.connect();
  await connected;
  await client.subscribeAsync(opts.topic, { qos: 1 });
  return client;
}
