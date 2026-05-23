import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import mqtt, { type MqttClient } from "mqtt";
import { createPgDb, type Db } from "../db/db.js";
import { migrate } from "../db/schema.js";
import { topicFor, type Telemetry } from "../domain/telemetry.js";
import type { IngestStats } from "../ingest/ingestor.js";
import { generateFleet, injectFaults } from "../sim/fleet.js";
import * as dc from "./docker.js";
import { checkInvariants, type InvariantReport, type RunSnapshot } from "./invariants.js";
import { Toxiproxy } from "./toxiproxy.js";

/** Addresses of the chaos environment (see docker-compose.chaos.yml). */
export const ENDPOINTS = {
  /** Direct to Mosquitto: the simulator publishes here. */
  mqtt: process.env.CHAOS_MQTT_URL ?? "mqtt://127.0.0.1:21884",
  /** Direct to PostgreSQL: the checker reads here. */
  db: process.env.CHAOS_DATABASE_URL ?? "postgres://fleet:fleet@127.0.0.1:25434/fleet",
  api: process.env.CHAOS_API_URL ?? "http://127.0.0.1:23001",
  /** Must match MQTT_CLIENT_ID of the ingest service. */
  ingestClientId: "fleet-ingest-chaos",
};

export interface RunConfig {
  seed: number;
  devices: number;
  tripsPerDevice: number;
  /** Publish rate in messages per second. */
  rate: number;
  /** Inject the fault once this fraction of the deliveries has been published. */
  faultAt: number;
}

export const DEFAULT_RUN: Omit<RunConfig, "seed"> = {
  devices: 8,
  tripsPerDevice: 3,
  rate: 1500,
  faultAt: 0.3,
};

export interface FaultContext {
  toxiproxy: Toxiproxy;
  log: (msg: string) => void;
}

export interface FaultTiming {
  /** Wall-clock time the fault started. */
  injectedAt: number;
  /** Wall-clock time the fault was removed (component back, toxic removed). */
  healedAt: number;
  note?: string;
}

export interface Scenario {
  name: string;
  title: string;
  description: string;
  /** Injects the fault, waits, heals it. Absent for the fault-free baseline. */
  inject?: (ctx: FaultContext) => Promise<FaultTiming>;
  /** Extra checks after the run (e.g. the exit code of a graceful stop). */
  verify?: () => Promise<string[]>;
}

export interface RunResult extends Omit<InvariantReport, "examples"> {
  scenario: string;
  seed: number;
  deliveries: number;
  trips: number;
  latePoints: number;
  /** Time the fault lasted (inject to heal). */
  downtimeMs: number | null;
  /** Time from healing the fault until the service committed new rows again. */
  recoveryMs: number | null;
  /** Time from healing the fault until every message published so far was stored. */
  catchUpMs: number | null;
  /** Highest in-memory queue depth seen (polled every 100 ms, plus the service's own peak). */
  peakQueueDepth: number;
  queueCapacity: number;
  /** Whether the service paused its MQTT consumer because the queue was full. */
  paused: boolean;
  /** Redelivered copies the service discarded as duplicates (stats of the last process only). */
  duplicatesDiscarded: number;
  batchErrors: number;
  reloads: number;
  totalMs: number;
  extraFailures: string[];
  examples: string[];
  note?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchStats(timeoutMs = 1000): Promise<IngestStats | null> {
  try {
    const res = await fetch(`${ENDPOINTS.api}/api/stats`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return ((await res.json()) as { ingest: IngestStats | null }).ingest;
  } catch {
    return null;
  }
}

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs: number, everyMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** The Compose environment plus the direct database connection the checker uses. */
export class ChaosEnv {
  readonly toxiproxy = new Toxiproxy();
  private db: Db | null = null;
  private baselines = new Map<number, RunSnapshot>();

  constructor(
    private readonly log: (msg: string) => void = () => undefined,
    private readonly baselineDir = "results/tmp/chaos",
  ) {}

  /** Builds the service image and starts broker, database and Toxiproxy (the service is started per run). */
  async up(): Promise<void> {
    // Baselines are only valid for the build under test.
    rmSync(this.baselineDir, { recursive: true, force: true });
    this.log("building service image and starting mosquitto, postgres, toxiproxy");
    await dc.compose(["build", "ingest"], 900_000);
    await dc.compose(["up", "-d", "--wait", "mosquitto", "postgres", "toxiproxy"]);
    await dc.compose(["up", "-d", "--no-start", "ingest"]);
    await waitFor("toxiproxy", async () => (await this.toxiproxy.proxies()).postgres !== undefined, 30_000);
  }

  async down(): Promise<void> {
    await this.db?.close().catch(() => undefined);
    this.db = null;
    await dc.compose(["down", "-v", "--remove-orphans"]);
  }

  async database(): Promise<Db> {
    if (!this.db) this.db = createPgDb(ENDPOINTS.db, { max: 3, connectTimeoutMs: 5_000, queryTimeoutMs: 30_000 });
    return this.db;
  }

  async storedCount(): Promise<number> {
    const db = await this.database();
    return Number((await db.query<{ n: number }>("SELECT count(*) AS n FROM points")).rows[0]!.n);
  }

  /** Stops the service, clears the database and the broker session, and starts the service fresh. */
  async reset(): Promise<void> {
    await this.toxiproxy.reset();
    if ((await dc.containerState("ingest")).running) await dc.stop("ingest");
    // Broker and database may have been restarted by the previous scenario.
    const db = await this.database();
    await waitFor("postgres", async () => (await migrate(db), true), 60_000, 250);
    await db.exec("TRUNCATE points, trips, idle_segments, devices RESTART IDENTITY");
    // Connecting with clean: true discards the service's persistent session and anything queued in it.
    const wipe = await connectWithRetry(ENDPOINTS.mqtt, { clientId: ENDPOINTS.ingestClientId, clean: true });
    await wipe.endAsync();
    await this.startService();
  }

  async startService(): Promise<void> {
    await dc.start("ingest");
    await waitFor("ingest service ready", async () => (await fetchStats())?.sourceConnected === true, 60_000);
  }

  async snapshot(): Promise<RunSnapshot> {
    const db = await this.database();
    const q = async <T>(sql: string) => (await db.query<T>(sql)).rows;
    return {
      points: await q("SELECT device_id, seq FROM points ORDER BY device_id, seq"),
      latePoints: await q("SELECT device_id, seq FROM points WHERE late ORDER BY device_id, seq"),
      trips: await q(
        `SELECT device_id, start_seq, end_seq, start_ts::text AS start_ts, end_ts::text AS end_ts, distance_m,
                duration_s, idle_s, point_count, max_speed_kph, end_reason
         FROM trips ORDER BY device_id, start_seq`,
      ),
      idleSegments: await q(
        `SELECT device_id, start_seq, start_ts::text AS start_ts, end_ts::text AS end_ts, duration_s
         FROM idle_segments ORDER BY device_id, start_seq`,
      ),
    };
  }

  /** The fault-free run for a seed, run once per environment and cached on disk. */
  async baseline(cfg: RunConfig): Promise<RunSnapshot> {
    const cached = this.baselines.get(cfg.seed);
    if (cached) return cached;
    const file = `${this.baselineDir}/baseline-${cfg.seed}-${cfg.devices}x${cfg.tripsPerDevice}.json`;
    if (existsSync(file)) {
      const snap = JSON.parse(readFileSync(file, "utf8")) as RunSnapshot;
      this.baselines.set(cfg.seed, snap);
      return snap;
    }
    this.log(`seed ${cfg.seed}: fault-free baseline run`);
    const { result, snapshot } = await this.execute(BASELINE, cfg, null);
    if (!result.ok) throw new Error(`baseline run for seed ${cfg.seed} failed: ${JSON.stringify(result.examples)}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(snapshot));
    this.baselines.set(cfg.seed, snapshot);
    return snapshot;
  }

  /** Runs one scenario for one seed and checks every invariant against the fault-free run. */
  async run(scenario: Scenario, cfg: RunConfig): Promise<RunResult> {
    const base = scenario.inject ? await this.baseline(cfg) : null;
    return (await this.execute(scenario, cfg, base)).result;
  }

  private async execute(
    scenario: Scenario,
    cfg: RunConfig,
    baseline: RunSnapshot | null,
  ): Promise<{ result: RunResult; snapshot: RunSnapshot }> {
    const t0 = Date.now();
    await this.reset();
    const fleet = generateFleet({ seed: cfg.seed, devices: cfg.devices, tripsPerDevice: cfg.tripsPerDevice });
    const { deliveries } = injectFaults(fleet.messages, { seed: cfg.seed + 1 });
    const msgs = deliveries.map((d) => d.msg);
    const expectedKeys = new Set(msgs.map((m) => `${m.deviceId}#${m.seq}`));

    // Monitor: queue depth from the service, stored count from the database.
    let peak = 0;
    let queueCapacity = 0;
    let paused = false;
    let lastStats: IngestStats | null = null;
    const samples: { t: number; stored: number }[] = [];
    let monitoring = true;
    const statsLoop = (async () => {
      while (monitoring) {
        const s = await fetchStats(500);
        if (s) {
          lastStats = s;
          peak = Math.max(peak, s.pending, s.queuePeak);
          queueCapacity = s.queueCapacity;
          paused ||= s.paused || s.pauses > 0;
        }
        await sleep(100);
      }
    })();
    const countLoop = (async () => {
      while (monitoring) {
        const n = await this.storedCount().catch(() => null);
        if (n !== null) samples.push({ t: Date.now(), stored: n });
        await sleep(50);
      }
    })();

    // Publish in delivery order, paced; inject the fault part-way through.
    const pub = await connectWithRetry(ENDPOINTS.mqtt, { clientId: `chaos-pub-${scenario.name}-${cfg.seed}`, clean: true });
    let timing: FaultTiming | null = null;
    let faultPromise: Promise<void> | null = null;
    let faultError: unknown = null;
    const publishedAt: number[] = [];
    const faultIndex = Math.floor(msgs.length * cfg.faultAt);
    await paced(pub, msgs, cfg.rate, (i) => {
      publishedAt[i] = Date.now();
      if (i === faultIndex && scenario.inject && !faultPromise) {
        faultPromise = scenario
          .inject({ toxiproxy: this.toxiproxy, log: this.log })
          .then((t) => void (timing = t))
          .catch((e) => void (faultError = e));
      }
    });
    if (faultPromise) await faultPromise;
    await pub.endAsync();
    if (faultError) throw faultError;

    // Wait until everything is stored, applied and released from the reorder buffers.
    let settleError: string | null = null;
    await waitFor(
      "all messages stored and reorder buffers released",
      async () => {
        const s = await fetchStats();
        return (await this.storedCount()) >= expectedKeys.size && s !== null && s.pending === 0 && s.buffered === 0;
      },
      120_000,
      250,
    ).catch((e: Error) => (settleError = e.message));
    monitoring = false;
    await Promise.all([statsLoop, countLoop]);

    const snapshot = await this.snapshot();
    const report = checkInvariants(msgs, snapshot, baseline ?? undefined);
    const extraFailures = [...(settleError ? [settleError] : []), ...((await scenario.verify?.()) ?? [])];

    let recoveryMs: number | null = null;
    let catchUpMs: number | null = null;
    const t = timing as FaultTiming | null;
    if (t) {
      const atHeal = [...samples].reverse().find((s) => s.t <= t.healedAt)?.stored ?? 0;
      const firstCommit = samples.find((s) => s.t > t.healedAt && s.stored > atHeal);
      recoveryMs = firstCommit ? firstCommit.t - t.healedAt : null;
      // Distinct messages published before the heal; the backlog is cleared once that many are stored.
      const before = new Set<string>();
      msgs.forEach((m, i) => {
        if ((publishedAt[i] ?? Infinity) <= t.healedAt) before.add(`${m.deviceId}#${m.seq}`);
      });
      const caught = samples.find((s) => s.t > t.healedAt && s.stored >= before.size);
      catchUpMs = caught ? caught.t - t.healedAt : null;
    }
    const s = lastStats as IngestStats | null;
    const { examples, ...rest } = report;
    const result: RunResult = {
      scenario: scenario.name,
      seed: cfg.seed,
      deliveries: msgs.length,
      trips: snapshot.trips.length,
      latePoints: snapshot.latePoints.length,
      ...rest,
      ok: report.ok && extraFailures.length === 0,
      downtimeMs: t ? t.healedAt - t.injectedAt : null,
      recoveryMs,
      catchUpMs,
      peakQueueDepth: peak,
      queueCapacity,
      paused,
      duplicatesDiscarded: s?.duplicates ?? 0,
      batchErrors: s?.batchErrors ?? 0,
      reloads: s?.reloads ?? 0,
      totalMs: Date.now() - t0,
      extraFailures,
      examples,
      ...(t?.note ? { note: t.note } : {}),
    };
    this.log(
      `${scenario.name} seed ${cfg.seed}: ${result.ok ? "OK" : "FAILED"} lost=${result.lost} dup=${result.duplicates} ` +
        `tripsMatch=${result.tripsMatch} recovery=${recoveryMs}ms peakQueue=${peak}`,
    );
    if (!result.ok) this.log(`  ${[...result.tripDiffs, ...examples, ...extraFailures].slice(0, 10).join("\n  ")}`);
    return { result, snapshot };
  }
}

export const BASELINE: Scenario = {
  name: "baseline",
  title: "No fault",
  description: "Fault-free run used as the reference for trips, idle segments and late flags.",
};

async function connectWithRetry(url: string, opts: mqtt.IClientOptions): Promise<MqttClient> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return await mqtt.connectAsync(url, { reconnectPeriod: 200, connectTimeout: 3_000, ...opts });
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await sleep(250);
    }
  }
}

/**
 * Publishes messages in order at QoS 1 on one connection, at most `rate` per second and with a
 * bounded number awaiting PUBACK. mqtt.js keeps unacknowledged publishes and resends them after
 * a reconnect, so a broker restart delays messages but does not lose them.
 */
async function paced(client: MqttClient, msgs: readonly Telemetry[], rate: number, onPublish: (i: number) => void) {
  const inflight = new Set<Promise<unknown>>();
  const started = Date.now();
  for (let i = 0; i < msgs.length; i++) {
    const due = started + (i * 1000) / rate;
    const wait = due - Date.now();
    if (wait > 2) await sleep(wait);
    const m = msgs[i]!;
    const p: Promise<unknown> = client.publishAsync(topicFor(m.deviceId), JSON.stringify(m), { qos: 1 }).finally(() => {
      inflight.delete(p);
    });
    inflight.add(p);
    onPublish(i);
    if (inflight.size >= 500) await Promise.race(inflight);
  }
  await withTimeout(Promise.all(inflight), 120_000, "publisher acknowledgements");
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms)));
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}
