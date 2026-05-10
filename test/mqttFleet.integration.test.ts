import mqtt from "mqtt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db.js";
import { createPgliteDb } from "../src/db/pglite.js";
import { migrate } from "../src/db/schema.js";
import { Ingestor } from "../src/ingest/ingestor.js";
import { startSubscriber } from "../src/ingest/mqttSubscriber.js";
import { generateFleet, injectFaults } from "../src/sim/fleet.js";
import { publishAll } from "../src/sim/publisher.js";
import { startBroker } from "./helpers/broker.js";
import { compareTrips, loadTrips } from "./helpers/fleetCheck.js";

let broker: Awaited<ReturnType<typeof startBroker>>;
let db: Db;

beforeAll(async () => {
  broker = await startBroker();
  db = await createPgliteDb();
  await migrate(db);
});
afterAll(async () => {
  await broker.close();
  await db.close();
});

describe("seeded fleet over MQTT", () => {
  it("replays a faulty fleet through a broker and reproduces ground-truth trips", async () => {
    const fleet = generateFleet({ seed: 2026, devices: 15, tripsPerDevice: 4 });
    const { deliveries, stats } = injectFaults(fleet.messages, { seed: 2027 });

    const ingestor = new Ingestor(db, { batchMaxSize: 500, batchMaxDelayMs: 10 });
    const sub = await startSubscriber(ingestor, { url: broker.url, topic: "fleet/+/telemetry", clientId: "test-ingest" });
    const pub = await mqtt.connectAsync(broker.url, { clientId: "test-sim" });
    // A malformed message and one on a mismatched topic are rejected, not stored.
    await pub.publishAsync("fleet/veh-0001/telemetry", "{oops", { qos: 1 });
    await pub.publishAsync("fleet/veh-0002/telemetry", JSON.stringify(fleet.messages[0]), { qos: 1 });

    await publishAll(pub, deliveries.map((d) => d.msg));
    const expected = deliveries.length + 2;
    const deadline = Date.now() + 60_000;
    while (ingestor.stats.received < expected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    await pub.endAsync();
    await sub.endAsync();
    await ingestor.drain();

    expect(ingestor.stats.received).toBe(expected);
    expect(ingestor.stats.invalid).toBe(2);
    expect(ingestor.stats.duplicates).toBe(stats.duplicates);
    const stored = await db.query<{ n: number }>("SELECT count(*) AS n FROM points");
    expect(Number(stored.rows[0]!.n)).toBe(stats.emitted - stats.dropped);

    const cmp = compareTrips(fleet.trips, await loadTrips(db));
    expect(cmp.perDeviceCountMismatch).toEqual([]);
    expect(cmp.actualTrips).toBe(fleet.trips.length);
    expect(cmp.maxDistanceError).toBeLessThan(0.01);
  });
});
