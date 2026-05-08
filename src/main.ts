import { loadConfig } from "./config.js";
import { createPgDb, type Db } from "./db/db.js";
import { migrate } from "./db/schema.js";
import { buildApi } from "./api/server.js";
import { Ingestor } from "./ingest/ingestor.js";
import { startSubscriber } from "./ingest/mqttSubscriber.js";

async function openDb(url: string): Promise<Db> {
  if (url === "pglite://memory") {
    // Zero-dependency demo mode: in-process Postgres, data is lost on exit.
    const { createPgliteDb } = await import("./db/pglite.js");
    return createPgliteDb();
  }
  return createPgDb(url);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = (level: string, msg: string, extra?: Record<string, unknown>) =>
    console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }));

  const db = await openDb(config.databaseUrl);
  await migrate(db);

  const ingestor = new Ingestor(db, {
    trip: config.trip,
    reorder: { windowMs: config.reorderWindowMs, maxBuffered: 500 },
    batchMaxSize: config.batchMaxSize,
    batchMaxDelayMs: config.batchMaxDelayMs,
    staleFlushMs: config.staleFlushMs,
    log,
  });
  const recovered = await ingestor.recover();
  log("info", "recovered device state by replay", { devices: recovered });
  ingestor.start();

  const api = await buildApi({ db, stats: () => ingestor.stats, webDist: config.webDist });
  await api.listen({ host: config.httpHost, port: config.httpPort });
  log("info", "http listening", { url: `http://${config.httpHost}:${config.httpPort}` });

  const mqttClient = await startSubscriber(ingestor, { url: config.mqttUrl, topic: config.mqttTopic });
  log("info", "subscribed", { url: config.mqttUrl, topic: config.mqttTopic });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("info", "shutting down", { signal });
    await mqttClient.endAsync().catch(() => undefined);
    await ingestor.close().catch((e) => log("error", "drain failed", { error: String(e) }));
    await api.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
