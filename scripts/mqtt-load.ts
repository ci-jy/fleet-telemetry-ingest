/**
 * MQTT publish-rate test: publishes simulated vehicles at fixed offered rates through the broker
 * to the running ingestion service and measures, per message, the latency from the publish call
 * to the moment its row was stored in Postgres (points.stored_at, set by clock_timestamp() inside
 * the inserting transaction). Publisher, broker, service and database share one host clock.
 *
 *   npm run load:mqtt -- --rates 1000,2500,5000 --duration 30 --devices 500
 *
 * Results are written to results/mqtt-load.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import mqtt, { type MqttClient } from "mqtt";
import pg from "pg";
import type { Telemetry } from "../src/domain/telemetry.js";
import { generateFleet } from "../src/sim/fleet.js";
import { numArg, parseArgs } from "./args.js";

const args = parseArgs();
const url = args.get("url") ?? process.env.MQTT_URL ?? "mqtt://127.0.0.1:21883";
const dbUrl = args.get("db") ?? process.env.DATABASE_URL ?? "postgres://fleet:fleet@127.0.0.1:25432/fleet";
const rates = (args.get("rates") ?? "1000,2500,5000").split(",").map(Number);
const durationS = numArg(args, "duration", 30);
const devices = numArg(args, "devices", 500);
const connections = numArg(args, "connections", 4);
const out = args.get("out") ?? "results/mqtt-load.json";

interface RunResult {
  offeredRate: number;
  durationS: number;
  devices: number;
  published: number;
  stored: number;
  lost: number;
  publishRate: number;
  storedThroughput: number;
  latencyMs: { p50: number; p95: number; p99: number; max: number; mean: number };
}

const pct = (sorted: number[], p: number): number =>
  sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
const r1 = (x: number) => Math.round(x * 10) / 10;

async function runOnce(rate: number, runId: string, pool: pg.Pool): Promise<RunResult> {
  const prefix = `load-${runId}-${rate}`;
  const total = Math.round(rate * durationS);
  const perDevice = Math.ceil(total / devices) + 1;
  // Realistic vehicle streams (trips, idling, parking) so the state machine does real work.
  const fleet = generateFleet({
    seed: rate,
    devices,
    tripsPerDevice: Math.max(1, Math.ceil(perDevice / 150)),
    devicePrefix: prefix,
    heartbeatMs: 5_000,
  });
  const streams = new Map<string, Telemetry[]>();
  for (const m of fleet.messages) {
    const s = streams.get(m.deviceId) ?? [];
    if (s.length < perDevice) s.push(m);
    streams.set(m.deviceId, s);
  }
  // Interleave devices round-robin, as a fleet reporting on a common interval would.
  const order: Telemetry[] = [];
  const lists = [...streams.values()];
  for (let i = 0; order.length < total; i++) {
    for (const l of lists) if (i < l.length && order.length < total) order.push(l[i]!);
    if (i > perDevice) break;
  }

  const clients: MqttClient[] = await Promise.all(
    Array.from({ length: connections }, (_, i) =>
      mqtt.connectAsync(url, { clientId: `${prefix}-pub-${i}`, clean: true }),
    ),
  );
  const clientFor = new Map<string, MqttClient>();
  [...streams.keys()].forEach((id, i) => clientFor.set(id, clients[i % clients.length]!));

  const publishedAt = new Map<string, number>();
  const tickMs = 10;
  const started = Date.now();
  let sent = 0;
  const pending: Promise<unknown>[] = [];
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      const due = Math.min(order.length, Math.floor(((Date.now() - started) / 1000) * rate));
      while (sent < due) {
        const m = order[sent++]!;
        const t = performance.timeOrigin + performance.now();
        publishedAt.set(`${m.deviceId}/${m.seq}`, t);
        pending.push(clientFor.get(m.deviceId)!.publishAsync(`fleet/${m.deviceId}/telemetry`, JSON.stringify(m), { qos: 1 }));
      }
      if (sent >= order.length) {
        clearInterval(timer);
        resolve();
      }
    }, tickMs);
  });
  await Promise.all(pending);
  const publishEnd = Date.now();
  await Promise.all(clients.map((c) => c.endAsync()));

  // Wait for the service to store everything (or give up after 60 s of no progress).
  let stored = 0;
  let lastChange = Date.now();
  while (stored < order.length && Date.now() - lastChange < 60_000) {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM points WHERE device_id LIKE $1`, [`${prefix}-%`]);
    const n = rows[0].n as number;
    if (n !== stored) lastChange = Date.now();
    stored = n;
    if (stored < order.length) await new Promise((r) => setTimeout(r, 250));
  }

  const { rows } = await pool.query(
    `SELECT device_id, seq, extract(epoch FROM stored_at) * 1000 AS st FROM points WHERE device_id LIKE $1`,
    [`${prefix}-%`],
  );
  const lat: number[] = [];
  let lastStored = 0;
  for (const r of rows) {
    const p = publishedAt.get(`${r.device_id}/${r.seq}`);
    const st = Number(r.st);
    lastStored = Math.max(lastStored, st);
    if (p !== undefined) lat.push(st - p);
  }
  lat.sort((a, b) => a - b);
  const mean = lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length);
  return {
    offeredRate: rate,
    durationS,
    devices,
    published: order.length,
    stored,
    lost: order.length - stored,
    publishRate: r1(order.length / ((publishEnd - started) / 1000)),
    storedThroughput: r1(stored / ((lastStored - started) / 1000)),
    latencyMs: {
      p50: r1(pct(lat, 50)),
      p95: r1(pct(lat, 95)),
      p99: r1(pct(lat, 99)),
      max: r1(lat.at(-1) ?? NaN),
      mean: r1(mean),
    },
  };
}

const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
const runId = Date.now().toString(36);
const results: RunResult[] = [];
for (const rate of rates) {
  process.stdout.write(`offered ${rate} msg/s for ${durationS} s ... `);
  const r = await runOnce(rate, runId, pool);
  results.push(r);
  console.log(
    `published ${r.published} (${r.publishRate}/s), stored ${r.stored}, throughput ${r.storedThroughput}/s, ` +
      `latency p50 ${r.latencyMs.p50} ms, p95 ${r.latencyMs.p95} ms, p99 ${r.latencyMs.p99} ms, max ${r.latencyMs.max} ms`,
  );
  await new Promise((res) => setTimeout(res, 3000));
}
await pool.end();

mkdirSync("results", { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      host: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memoryGb: r1(os.totalmem() / 2 ** 30), node: process.version },
      config: { url, devices, durationS, connections, qos: 1 },
      results,
    },
    null,
    2,
  ) + "\n",
);
console.log(`results -> ${out}`);
