import * as dc from "./docker.js";
import type { FaultContext, FaultTiming, Scenario } from "./runner.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function timed(fn: () => Promise<void>, hold: () => Promise<void>, heal: () => Promise<void>): Promise<FaultTiming> {
  const injectedAt = Date.now();
  await fn();
  await hold();
  await heal();
  return { injectedAt, healedAt: Date.now() };
}

/** SIGKILL of the service in the middle of the stream (a batch is almost always in flight), then a restart. */
export const SIGKILL_INGEST: Scenario = {
  name: "sigkill-ingest",
  title: "SIGKILL the ingest service mid-batch",
  description:
    "docker kill -s KILL on the service while messages stream in, 1.5 s down, docker start. " +
    "Uncommitted messages were never acknowledged, so the broker redelivers them; reorder buffers are rebuilt from the database.",
  async inject({ log }: FaultContext) {
    const stats = await fetch("http://127.0.0.1:23001/api/stats", { signal: AbortSignal.timeout(500) })
      .then((r) => r.json() as Promise<{ ingest: { pending: number; batches: number } }>)
      .catch(() => null);
    const t = await timed(
      () => dc.kill("ingest", "KILL"),
      () => sleep(1500),
      () => dc.start("ingest"),
    );
    const note = stats ? `${stats.ingest.pending} messages queued, ${stats.ingest.batches} batches committed at kill` : undefined;
    log(`sigkill: ${note ?? "stats unavailable"}`);
    return { ...t, note };
  },
};

/** Graceful restart: SIGTERM must drain in-flight batches and exit 0. */
export const SIGTERM_INGEST: Scenario = {
  name: "sigterm-ingest",
  title: "SIGTERM the ingest service (graceful restart)",
  description:
    "docker stop (SIGTERM) on the service under load, then docker start. The service must stop consuming, commit and " +
    "acknowledge every queued message, disconnect and exit with status 0.",
  async inject() {
    let exitCode = -1;
    const t = await timed(
      async () => {
        await dc.stop("ingest", 20);
        exitCode = (await dc.containerState("ingest")).exitCode;
      },
      () => sleep(500),
      () => dc.start("ingest"),
    );
    lastSigtermExit = exitCode;
    return { ...t, note: `exit code ${exitCode}` };
  },
  async verify() {
    return lastSigtermExit === 0 ? [] : [`graceful stop exited with status ${lastSigtermExit}`];
  },
};
let lastSigtermExit = 0;

export const MOSQUITTO_RESTART: Scenario = {
  name: "mosquitto-restart",
  title: "Restart Mosquitto",
  description:
    "docker restart on the broker under load. The broker persists sessions and queued messages; the publisher resends " +
    "unacknowledged publishes and the service resumes its persistent session with capped reconnect backoff.",
  inject: () =>
    timed(
      () => dc.restart("mosquitto", 10),
      async () => undefined,
      async () => undefined,
    ),
};

export const POSTGRES_RESTART: Scenario = {
  name: "postgres-restart",
  title: "Restart PostgreSQL",
  description:
    "docker restart on the database under load. In-flight transactions fail, the service retries with backoff and " +
    "rebuilds the affected devices from the database before retrying.",
  inject: () =>
    timed(
      () => dc.restart("postgres", 10),
      async () => undefined,
      async () => undefined,
    ),
};

export const NETWORK_LATENCY: Scenario = {
  name: "network-latency",
  title: "Added network latency (MQTT and database links)",
  description:
    "Toxiproxy latency toxics, 250 ms ± 100 ms on the database link and 150 ms ± 50 ms on the MQTT link, both directions, for 5 s.",
  async inject({ toxiproxy }) {
    const add = async (proxy: string, latency: number, jitter: number) => {
      for (const stream of ["upstream", "downstream"] as const) {
        await toxiproxy.addToxic(proxy, { name: `lat-${stream}`, type: "latency", stream, attributes: { latency, jitter } });
      }
    };
    return timed(
      async () => {
        await add("postgres", 250, 100);
        await add("mqtt", 150, 50);
      },
      () => sleep(5000),
      () => toxiproxy.reset().then(() => undefined),
    );
  },
};

export const DB_PARTITION: Scenario = {
  name: "db-partition",
  title: "Network partition between the service and PostgreSQL",
  description:
    "Toxiproxy timeout toxics (timeout 0: data silently dropped, connections hang) on both directions of the database " +
    "link for 6 s. Queries time out, hung connections are discarded, the consumer pauses when the queue fills.",
  async inject({ toxiproxy }) {
    return timed(
      async () => {
        for (const stream of ["upstream", "downstream"] as const) {
          await toxiproxy.addToxic("postgres", { name: `part-${stream}`, type: "timeout", stream, attributes: { timeout: 0 } });
        }
      },
      () => sleep(6000),
      () => toxiproxy.reset().then(() => undefined),
    );
  },
};

export const SCENARIOS: Scenario[] = [
  SIGKILL_INGEST,
  SIGTERM_INGEST,
  MOSQUITTO_RESTART,
  POSTGRES_RESTART,
  NETWORK_LATENCY,
  DB_PARTITION,
];
