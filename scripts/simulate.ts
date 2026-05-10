/**
 * Publishes a seeded synthetic fleet (with injected duplicates, reordering and dropouts) to the
 * MQTT broker, optionally paced in compressed real time, and writes the ground truth to a file.
 * With --check it then compares the trips reported by the REST API with the ground truth.
 *
 *   npm run sim -- --seed 42 --devices 20 --trips 4 [--speedup 0] [--check]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import mqtt from "mqtt";
import { generateFleet, injectFaults } from "../src/sim/fleet.js";
import { publishAll } from "../src/sim/publisher.js";
import { numArg, parseArgs } from "./args.js";

const args = parseArgs();
const url = args.get("url") ?? process.env.MQTT_URL ?? "mqtt://127.0.0.1:21883";
const api = args.get("api") ?? `http://127.0.0.1:${process.env.PORT ?? 23000}`;
const seed = numArg(args, "seed", 42);
const speedup = numArg(args, "speedup", 0); // 0 = as fast as possible, 60 = one simulated minute per second
const truthFile = args.get("truth") ?? `results/tmp/ground-truth-${seed}.json`;

const fleet = generateFleet({
  seed,
  devices: numArg(args, "devices", 20),
  tripsPerDevice: numArg(args, "trips", 4),
  devicePrefix: args.get("prefix") ?? "veh",
  ...(speedup > 0 ? { startTs: Date.now() } : {}),
});
const { deliveries, stats } = injectFaults(fleet.messages, { seed: seed + 1 });
mkdirSync(dirname(truthFile), { recursive: true });
writeFileSync(truthFile, JSON.stringify({ seed, faults: stats, trips: fleet.trips }, null, 2));
console.log(
  `fleet seed=${seed}: ${fleet.config.devices} devices, ${fleet.trips.length} ground-truth trips, ` +
    `${deliveries.length} deliveries (${stats.dropped} dropped, ${stats.duplicates} duplicates, ` +
    `${stats.reordered} reordered, ${stats.late} late); truth -> ${truthFile}`,
);

const client = await mqtt.connectAsync(url, { clientId: `fleet-sim-${seed}-${process.pid}` });
const started = Date.now();
if (speedup > 0) {
  const t0 = deliveries[0]?.deliverAt ?? 0;
  for (const d of deliveries) {
    const due = started + (d.deliverAt - t0) / speedup;
    const wait = due - Date.now();
    if (wait > 5) await new Promise((r) => setTimeout(r, wait));
    await client.publishAsync(`fleet/${d.msg.deviceId}/telemetry`, JSON.stringify(d.msg), { qos: 1 });
  }
} else {
  await publishAll(client, deliveries.map((d) => d.msg));
}
await client.endAsync();
console.log(`published ${deliveries.length} messages in ${((Date.now() - started) / 1000).toFixed(1)} s`);

if (args.has("check")) {
  // Wait until the service has applied everything (reorder buffers are released after a quiet period).
  const deadline = Date.now() + 120_000;
  let trips: { deviceId: string; startTs: string; distanceKm: number }[] = [];
  while (Date.now() < deadline) {
    trips = [];
    for (const id of new Set(fleet.trips.map((t) => t.deviceId))) {
      const res = await fetch(`${api}/api/devices/${id}/trips?limit=1000`);
      if (res.ok) trips.push(...((await res.json()) as typeof trips));
    }
    if (trips.length >= fleet.trips.length) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  let worst = 0;
  const byDevice = new Map<string, typeof trips>();
  for (const t of trips) byDevice.set(t.deviceId, [...(byDevice.get(t.deviceId) ?? []), t]);
  let countOk = true;
  for (const id of new Set(fleet.trips.map((t) => t.deviceId))) {
    const truth = fleet.trips.filter((t) => t.deviceId === id).sort((a, b) => a.startTs - b.startTs);
    const got = (byDevice.get(id) ?? []).sort((a, b) => Date.parse(a.startTs) - Date.parse(b.startTs));
    if (got.length !== truth.length) {
      countOk = false;
      console.log(`${id}: expected ${truth.length} trips, got ${got.length}`);
      continue;
    }
    truth.forEach((t, i) => {
      worst = Math.max(worst, Math.abs(got[i]!.distanceKm * 1000 - t.distanceM) / t.distanceM);
    });
  }
  console.log(
    `check: ${trips.length}/${fleet.trips.length} trips, max distance error ${(worst * 100).toFixed(2)}% -> ` +
      (countOk && worst < 0.01 ? "OK" : "MISMATCH"),
  );
  if (!countOk || worst >= 0.01) process.exitCode = 1;
}
