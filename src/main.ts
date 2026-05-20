import { loadConfig } from "./config.js";
import { createPgDb, type Db } from "./db/db.js";
import { migrate } from "./db/schema.js";
import { buildApi } from "./api/server.js";
import { Ingestor } from "./ingest/ingestor.js";
import { startSubscriber } from "./ingest/mqttSubscriber.js";

async function openDb(url: string, config: ReturnType<typeof loadConfig>): Promise<Db> {
  if (url === "pglite://memory") {
    // Zero-dependency demo mode: in-process Postgres, data is lost on exit.
    const { createPgliteDb } = await import("./db/pglite.js");
    return createPgliteDb();
  }
  return createPgDb(url, { connectTimeoutMs: config.dbConnectTimeoutMs, queryTimeoutMs: config.dbQueryTimeoutMs });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = (level: string, msg: string, extra?: Record<string, unknown>) =>
    console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

  const db = await openDb(config.databaseUrl, config);
  await withRetry(() => migrate(db), log);

  const ingestor = new Ingestor(db, {
    trip: config.trip,
    reorder: { windowMs: config.reorderWindowMs, maxBuffered: 500 },
    batchMaxSize: config.batchMaxSize,
    batchMaxDelayMs: config.batchMaxDelayMs,
    staleFlushMs: config.staleFlushMs,
    maxPending: config.queueMax,
    retryDelayMs: config.retryDelayMs,
    retryMaxDelayMs: config.retryMaxDelayMs,
    log,
  });
  const recovered = await withRetry(() => ingestor.recover(), log);
  log("info", "recovered device state by replay", { devices: recovered });
  ingestor.start();

  const api = await buildApi({ db, stats: () => ingestor.stats, webDist: config.webDist });
  await api.listen({ host: config.httpHost, port: config.httpPort });
  log("info", "http listening", { url: `http://${config.httpHost}:${config.httpPort}` });

  const mqttClient = await startSubscriber(ingestor, {
    url: config.mqttUrl,
    topic: config.mqttTopic,
    clientId: config.mqttClientId,
    reconnectMinMs: config.mqttReconnectMinMs,
    reconnectMaxMs: config.mqttReconnectMaxMs,
    log,
  });
  log("info", "subscribed", { url: config.mqttUrl, topic: config.mqttTopic });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("info", "shutting down", { signal, pending: ingestor.stats.pending });
    // Stop taking messages, commit and acknowledge what is queued, then disconnect cleanly.
    // Anything not committed in time was never acknowledged and stays with the broker.
    const result = await ingestor.shutdown(config.shutdownTimeoutMs);
    log(result.drained ? "info" : "error", "drained in-flight batches", result);
    await mqttClient.endAsync().catch(() => undefined);
    await api.close();
    await db.close().catch(() => undefined);
    process.exit(result.drained ? 0 : 1);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

/** Retries startup steps that need the database, with capped exponential backoff, for up to a minute. */
async function withRetry<T>(fn: () => Promise<T>, log: (level: string, msg: string, extra?: Record<string, unknown>) => void): Promise<T> {
  const deadline = Date.now() + 60_000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      const delay = Math.min(5_000, 250 * 2 ** attempt);
      log("warn", "startup step failed, retrying", { error: String(err), retryInMs: delay });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
