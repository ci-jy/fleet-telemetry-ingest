/**
 * In-cluster chaos runner (the chart's e2e Job). For each scenario it publishes a seeded
 * synthetic fleet over MQTT QoS 1 to the partitioned topics, injects the fault through the
 * Kubernetes API while publishing, waits for the ingest pods to store everything, and checks the
 * exact-once ledger: every delivered (device, seq) stored once, nothing extra.
 *
 * Scenarios: pod-kill (random ingest pod SIGKILLed every few seconds), scale (1 -> 3 -> 2 replicas),
 * mosquitto-restart, postgres-restart. Prints one `K8S_CHAOS_REPORT <json>` line and exits 1 if any
 * scenario lost or duplicated a message.
 */
import mqtt, { type MqttClient } from "mqtt";
import { partitionTopic } from "../src/cluster/partition.js";
import { checkInvariants, type RunSnapshot } from "../src/chaos/invariants.js";
import { createPgDb, type Db } from "../src/db/db.js";
import type { Telemetry } from "../src/domain/telemetry.js";
import { Kube } from "../src/k8s/kube.js";
import { generateFleet, injectFaults } from "../src/sim/fleet.js";

const env = (k: string, d: string): string => process.env[k] ?? d;
const num = (k: string, d: number): number => Number(process.env[k] ?? d);
const cfg = {
  namespace: env("NAMESPACE", "default"),
  mqttUrl: env("MQTT_URL", "mqtt://mosquitto:1883"),
  databaseUrl: env("DATABASE_URL", "postgres://fleet:fleet@postgres:5432/fleet"),
  prometheusUrl: env("PROMETHEUS_URL", ""),
  ingestStatefulSet: env("INGEST_STATEFULSET", "ingest"),
  ingestSelector: env("INGEST_SELECTOR", "app.kubernetes.io/component=ingest"),
  mosquittoSelector: env("MOSQUITTO_SELECTOR", "app.kubernetes.io/component=mosquitto"),
  postgresSelector: env("POSTGRES_SELECTOR", "app.kubernetes.io/component=postgres"),
  partitions: num("PARTITIONS", 16),
  replicas: num("REPLICAS", 3),
  devices: num("DEVICES", 200),
  trips: num("TRIPS", 1),
  rate: num("RATE", 1500),
  seed: num("SEED", 7),
  faultAt: num("FAULT_AT", 0.2),
  podKills: num("POD_KILLS", 4),
  podKillEveryMs: num("POD_KILL_EVERY_MS", 4000),
  settleTimeoutMs: num("SETTLE_TIMEOUT_MS", 300_000),
  scenarios: env("SCENARIOS", "pod-kill,scale,mosquitto-restart,postgres-restart").split(",").filter(Boolean),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

async function waitFor(what: string, cond: () => Promise<boolean>, timeoutMs: number, everyMs = 250): Promise<number> {
  const start = Date.now();
  for (;;) {
    if (await cond().catch(() => false)) return Date.now() - start;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(everyMs);
  }
}

interface Fault {
  /** Runs the fault; resolves with the time the last disruptive action was taken. */
  run: (kube: Kube) => Promise<{ lastActionAt: number; actions: string[] }>;
}

const readyIngest = async (kube: Kube, n: number) =>
  (await kube.statefulSet(cfg.ingestStatefulSet)).readyReplicas === n &&
  (await kube.pods(cfg.ingestSelector)).filter((p) => p.ready).length === n;

async function restartPod(kube: Kube, selector: string, label: string) {
  const [pod] = await kube.pods(selector);
  if (!pod) throw new Error(`no ${label} pod`);
  await kube.deletePod(pod.name);
  await waitFor(`${label} back`, async () => {
    const pods = await kube.pods(selector);
    return pods.length === 1 && pods[0]!.ready;
  }, 180_000, 500);
  return { lastActionAt: Date.now(), actions: [`deleted ${pod.name} (graceful)`, `${label} ready again`] };
}

const FAULTS: Record<string, Fault> = {
  "pod-kill": {
    async run(kube) {
      const actions: string[] = [];
      let last = Date.now();
      for (let i = 0; i < cfg.podKills; i++) {
        const pods = await kube.pods(cfg.ingestSelector);
        const victim = pods[(cfg.seed * 7 + i * 13) % pods.length]!;
        await kube.deletePod(victim.name, 0);
        last = Date.now();
        actions.push(`killed ${victim.name}`);
        await sleep(cfg.podKillEveryMs);
      }
      return { lastActionAt: last, actions };
    },
  },
  scale: {
    async run(kube) {
      const actions: string[] = [];
      for (const n of [1, 3, 2]) {
        await kube.scaleStatefulSet(cfg.ingestStatefulSet, n);
        const ms = await waitFor(`${n} ingest replicas`, () => readyIngest(kube, n), 180_000, 500);
        actions.push(`scaled to ${n} (ready after ${ms} ms)`);
        await waitFor("every partition owned", allOwned, 120_000, 250);
        await sleep(3000);
      }
      return { lastActionAt: Date.now(), actions };
    },
  },
  "mosquitto-restart": { run: (kube) => restartPod(kube, cfg.mosquittoSelector, "mosquitto") },
  "postgres-restart": { run: (kube) => restartPod(kube, cfg.postgresSelector, "postgres") },
};

let checker: Db;

async function allOwned(): Promise<boolean> {
  const { rows } = await checker.query<{ n: number; owned: number }>(
    `SELECT count(*) AS n, count(*) FILTER (WHERE owner IS NOT NULL AND expires_at > now()) AS owned FROM partition_leases`,
  );
  return Number(rows[0]!.n) === cfg.partitions && Number(rows[0]!.owned) === cfg.partitions;
}

async function connectPublisher(clientId: string): Promise<MqttClient> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      return await mqtt.connectAsync(cfg.mqttUrl, {
        clientId,
        clean: true,
        protocolVersion: 5,
        reconnectPeriod: 250,
        connectTimeout: 3_000,
      });
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await sleep(500);
    }
  }
}

/** Publishes in delivery order at QoS 1, at most `rate` per second, stamping the send time. */
async function paced(client: MqttClient, msgs: readonly Telemetry[], onPublish: (i: number) => void): Promise<void> {
  const inflight = new Set<Promise<unknown>>();
  const started = Date.now();
  for (let i = 0; i < msgs.length; i++) {
    const wait = started + (i * 1000) / cfg.rate - Date.now();
    if (wait > 2) await sleep(wait);
    const m = msgs[i]!;
    const p: Promise<unknown> = client
      .publishAsync(partitionTopic(m.deviceId, cfg.partitions), JSON.stringify(m), {
        qos: 1,
        properties: { userProperties: { pt: String(Date.now()) } },
      })
      .finally(() => inflight.delete(p));
    inflight.add(p);
    onPublish(i);
    if (inflight.size >= 500) await Promise.race(inflight);
  }
  await Promise.all(inflight);
}

async function snapshot(prefix: string): Promise<RunSnapshot> {
  const q = async <T>(sql: string) => (await checker.query<T>(sql, [`${prefix}-%`])).rows;
  return {
    points: await q("SELECT device_id, seq FROM points WHERE device_id LIKE $1"),
    latePoints: await q("SELECT device_id, seq FROM points WHERE late AND device_id LIKE $1"),
    trips: await q(
      `SELECT device_id, start_seq, end_seq, start_ts::text AS start_ts, end_ts::text AS end_ts, distance_m,
              duration_s, idle_s, point_count, max_speed_kph, end_reason FROM trips WHERE device_id LIKE $1`,
    ),
    idleSegments: await q(
      `SELECT device_id, start_seq, start_ts::text AS start_ts, end_ts::text AS end_ts, duration_s
         FROM idle_segments WHERE device_id LIKE $1`,
    ),
  };
}

async function runScenario(kube: Kube, name: string, index: number) {
  const fault = FAULTS[name];
  if (!fault) throw new Error(`unknown scenario ${name}`);
  const prefix = `${name.replace(/[^a-z]/g, "").slice(0, 8)}${index}`;
  const fleet = generateFleet({ seed: cfg.seed + index, devices: cfg.devices, tripsPerDevice: cfg.trips, devicePrefix: prefix });
  const { deliveries, stats } = injectFaults(fleet.messages, { seed: cfg.seed + index + 100 });
  const msgs = deliveries.map((d) => d.msg);
  const expected = new Set(msgs.map((m) => `${m.deviceId}#${m.seq}`)).size;
  log("scenario start", { scenario: name, prefix, deliveries: msgs.length, distinct: expected, devices: cfg.devices });

  await waitFor("ingest replicas ready", () => readyIngest(kube, cfg.replicas), 180_000, 500);
  await waitFor("every partition owned", allOwned, 120_000);

  const stored = async () =>
    Number((await checker.query<{ n: number }>("SELECT count(*) AS n FROM points WHERE device_id LIKE $1", [`${prefix}-%`])).rows[0]!.n);

  // Ownership and progress samples, for the recovery time.
  const samples: { t: number; owned: boolean; stored: number }[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const [owned, n] = await Promise.all([allOwned().catch(() => false), stored().catch(() => -1)]);
      samples.push({ t: Date.now(), owned, stored: n });
      await sleep(200);
    }
  })();

  const pub = await connectPublisher(`e2e-pub-${prefix}`);
  const faultIndex = Math.floor(msgs.length * cfg.faultAt);
  let faultRun: Promise<{ lastActionAt: number; actions: string[] }> | null = null;
  let faultStartedAt = 0;
  const t0 = Date.now();
  await paced(pub, msgs, (i) => {
    if (i === faultIndex) {
      faultStartedAt = Date.now();
      faultRun = fault.run(kube);
      faultRun.catch(() => undefined);
    }
  });
  const publishMs = Date.now() - t0;
  const started = faultRun as Promise<{ lastActionAt: number; actions: string[] }> | null;
  if (!started) throw new Error("fault never started");
  const faultResult = await started;
  await pub.endAsync();

  let settleError: string | null = null;
  await waitFor("every message stored", async () => (await stored()) >= expected, cfg.settleTimeoutMs, 500).catch(
    (e: Error) => (settleError = e.message),
  );
  const completedAt = Date.now();
  // Restore the replica count for the next scenario.
  await kube.scaleStatefulSet(cfg.ingestStatefulSet, cfg.replicas);
  await waitFor("ingest replicas ready", () => readyIngest(kube, cfg.replicas), 180_000, 500);
  await waitFor("every partition owned", allOwned, 120_000);
  sampling = false;
  await sampler;

  const report = checkInvariants(msgs, await snapshot(prefix));
  // Recovery: from the last disruptive action until every partition is owned again and a new row
  // of this scenario has been committed.
  const healAt = faultResult.lastActionAt;
  const atHeal = [...samples].reverse().find((s) => s.t <= healAt && s.stored >= 0)?.stored ?? 0;
  const recovered = samples.find((s) => s.t > healAt && s.owned && s.stored > atHeal);
  const allStored = samples.find((s) => s.stored >= expected);
  const result = {
    scenario: name,
    devices: cfg.devices,
    sent: msgs.length,
    sentDistinct: expected,
    simulatorDuplicates: stats.duplicates,
    stored: report.stored,
    lost: report.lost,
    duplicated: report.duplicates,
    duplicateTrips: report.duplicateTrips,
    phantom: report.phantom,
    trips: (await snapshot(prefix)).trips.length,
    publishMs,
    faultStartedAfterMs: faultStartedAt - t0,
    faultDurationMs: healAt - faultStartedAt,
    recoveryMs: recovered ? recovered.t - healAt : allStored && allStored.t > healAt ? allStored.t - healAt : null,
    completeAfterFaultMs: completedAt - healAt,
    actions: faultResult.actions,
    errors: settleError ? [settleError] : [],
    examples: report.examples,
    ok: report.lost === 0 && report.duplicates === 0 && report.phantom === 0 && report.duplicateTrips === 0 && !settleError,
  };
  log("scenario done", result);
  return result;
}

async function prometheusCheck(kube: Kube) {
  if (!cfg.prometheusUrl) return null;
  const pods = (await kube.pods(cfg.ingestSelector)).length;
  let up = 0;
  // Targets appear within a scrape interval or two of a pod (re)starting.
  await waitFor(
    "prometheus scraping every ingest pod",
    async () => {
      const r = (await (await fetch(`${cfg.prometheusUrl}/api/v1/targets?state=active`)).json()) as {
        data: { activeTargets: { labels: Record<string, string>; health: string }[] };
      };
      up = r.data.activeTargets.filter((t) => t.labels.job === "ingest" && t.health === "up").length;
      return up === pods;
    },
    90_000,
    2000,
  ).catch(() => undefined);
  const rules = (await (await fetch(`${cfg.prometheusUrl}/api/v1/rules`)).json()) as {
    data: { groups: { rules: { name: string; type: string }[] }[] };
  };
  const alerts = rules.data.groups.flatMap((g) => g.rules).filter((r) => r.type === "alerting").map((r) => r.name);
  const query = async (q: string) => {
    const r = (await (await fetch(`${cfg.prometheusUrl}/api/v1/query?query=${encodeURIComponent(q)}`)).json()) as {
      data: { result: { value: [number, string] }[] };
    };
    const v = r.data.result[0]?.value[1];
    return v === undefined ? null : Number(v);
  };
  return {
    ingestPods: pods,
    targetsUp: up,
    allScraped: up === pods,
    alertRules: alerts,
    messagesStored: await query("sum(fleet_ingest_messages_total{outcome=\"stored\"})"),
    p95PublishToCommitSeconds: await query(
      "histogram_quantile(0.95, sum by (le) (rate(fleet_ingest_publish_to_commit_seconds_bucket[10m])))",
    ),
    leaseAcquisitions: await query("sum(fleet_lease_acquisitions_total)"),
  };
}

async function main() {
  const kube = new Kube(cfg.namespace);
  checker = createPgDb(cfg.databaseUrl, { max: 2 });
  await waitFor("database", async () => (await checker.query("SELECT 1 FROM partition_leases LIMIT 1"), true), 180_000, 1000);
  const started = Date.now();
  const scenarios = [];
  for (const [i, name] of cfg.scenarios.entries()) {
    try {
      scenarios.push(await runScenario(kube, name, i));
    } catch (err) {
      log("scenario failed", { scenario: name, error: String(err) });
      scenarios.push({ scenario: name, ok: false, errors: [String(err)] });
    }
  }
  const prometheus = await prometheusCheck(kube).catch((e: unknown) => ({ error: String(e) }));
  const totals = scenarios.reduce(
    (a, s) => ({
      sent: a.sent + ("sent" in s ? s.sent : 0),
      stored: a.stored + ("stored" in s ? s.stored : 0),
      lost: a.lost + ("lost" in s ? s.lost : 0),
      duplicated: a.duplicated + ("duplicated" in s ? s.duplicated : 0),
    }),
    { sent: 0, stored: 0, lost: 0, duplicated: 0 },
  );
  const ok = scenarios.every((s) => s.ok) && (prometheus === null || ("allScraped" in prometheus && prometheus.allScraped));
  const report = {
    generatedAt: new Date().toISOString(),
    config: { partitions: cfg.partitions, replicas: cfg.replicas, devices: cfg.devices, tripsPerDevice: cfg.trips, rate: cfg.rate, seed: cfg.seed },
    durationS: Math.round((Date.now() - started) / 1000),
    totals,
    scenarios,
    prometheus,
    ok,
  };
  console.log(`K8S_CHAOS_REPORT ${JSON.stringify(report)}`);
  await checker.close();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
