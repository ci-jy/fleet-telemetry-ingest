import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FencedError, LeaseStore, ownerId } from "../src/cluster/leases.js";
import { partitionOf } from "../src/cluster/partition.js";
import type { Db } from "../src/db/db.js";
import { createPgliteDb } from "../src/db/pglite.js";
import { migrate } from "../src/db/schema.js";
import { Ingestor } from "../src/ingest/ingestor.js";
import type { Telemetry } from "../src/domain/telemetry.js";

let db: Db;
beforeEach(async () => {
  db = await createPgliteDb();
  await migrate(db);
});
afterEach(async () => {
  await db.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const store = (pod: string, incarnation: string, ttlMs = 10_000) => new LeaseStore(db, ownerId(pod, incarnation), pod, ttlMs);

describe("partition leases", () => {
  it("gives a free partition to exactly one owner", async () => {
    const a = store("ingest-0", "a");
    const b = store("ingest-1", "b");
    await a.ensurePartitions(4);
    await a.ensurePartitions(4); // idempotent
    expect((await a.list()).length).toBe(4);

    const la = await a.acquire(2);
    expect(la).toEqual({ partition: 2, token: 1 });
    expect(await b.acquire(2)).toBeNull();
    // Renewing keeps the token.
    expect(await a.renew([la!])).toEqual(new Set([2]));
    expect((await a.list())[2]).toMatchObject({ owner: a.owner, token: 1 });
  });

  it("lets another pod take an expired lease with a higher fencing token", async () => {
    const a = store("ingest-0", "a", 60);
    const b = store("ingest-1", "b", 60);
    await a.ensurePartitions(2);
    const la = (await a.acquire(0))!;
    expect(await b.acquire(0)).toBeNull();
    await sleep(120);
    const lb = await b.acquire(0);
    expect(lb).toEqual({ partition: 0, token: la.token + 1 });
    // The old owner can no longer renew.
    expect(await a.renew([la])).toEqual(new Set());
  });

  it("rejects writes from a stale owner and accepts the current one", async () => {
    const a = store("ingest-0", "a", 60);
    const b = store("ingest-1", "b", 10_000);
    await a.ensurePartitions(2);
    const la = (await a.acquire(1))!;
    await db.transaction((tx) => a.fence(tx, [la])); // current owner passes
    await sleep(120);
    // Expired but not yet taken over: still refused.
    await expect(db.transaction((tx) => a.fence(tx, [la]))).rejects.toBeInstanceOf(FencedError);
    const lb = (await b.acquire(1))!;
    const err = await db.transaction((tx) => a.fence(tx, [la])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FencedError);
    expect((err as FencedError).partitions).toEqual([1]);
    // Even a forged token cannot pass for another owner.
    await expect(db.transaction((tx) => a.fence(tx, [lb]))).rejects.toBeInstanceOf(FencedError);
    await db.transaction((tx) => b.fence(tx, [lb]));
  });

  it("hands a released partition over at once", async () => {
    const a = store("ingest-0", "a");
    const b = store("ingest-1", "b");
    await a.ensurePartitions(1);
    const la = (await a.acquire(0))!;
    expect(await a.release(la)).toBe(true);
    expect(await a.release(la)).toBe(false); // only the holder of the token can release
    expect(await b.acquire(0)).toEqual({ partition: 0, token: 2 });
  });

  it("lets a restarted pod reclaim the leases of its dead incarnation without waiting", async () => {
    const old = store("ingest-0", "old");
    const restarted = store("ingest-0", "new");
    const other = store("ingest-1", "x");
    await old.ensurePartitions(1);
    const l1 = (await old.acquire(0))!;
    expect(await other.acquire(0)).toBeNull();
    const l2 = await restarted.acquire(0);
    expect(l2).toEqual({ partition: 0, token: l1.token + 1 });
    await expect(db.transaction((tx) => old.fence(tx, [l1]))).rejects.toBeInstanceOf(FencedError);
  });

  it("counts live members, excluding dead incarnations of the same pod", async () => {
    const a = store("ingest-0", "a");
    const a2 = store("ingest-0", "a2");
    const b = store("ingest-1", "b");
    expect(await a.heartbeat()).toBe(1);
    expect(await b.heartbeat()).toBe(2);
    expect(await a2.heartbeat()).toBe(2); // ingest-0~a is the same pod's previous incarnation
    await b.leaveMembership();
    expect(await a2.heartbeat()).toBe(1);
  });
});

describe("fenced ingestion", () => {
  const point = (deviceId: string, seq: number): Telemetry => ({
    deviceId,
    seq,
    ts: 1767600000000 + seq * 5000,
    lat: 52.5,
    lon: 13.4,
    speedKph: 0,
    ignition: false,
  });

  it("refuses a stale owner's batch, writes nothing and leaves its messages unacknowledged", async () => {
    const a = store("ingest-0", "a", 60);
    const b = store("ingest-1", "b");
    await a.ensurePartitions(4);
    const device = "veh-0001";
    const p = partitionOf(device, 4);
    const lease = (await a.acquire(p))!;
    const lost: number[][] = [];
    let ingestor: Ingestor;
    ingestor = new Ingestor(db, {
      partitions: 4,
      batchMaxDelayMs: 5,
      fence: (tx) => a.fence(tx, [lease]),
      onFenced: (err) => {
        lost.push(err.partitions);
        ingestor.dropWhere((id) => partitionOf(id, 4) === p);
      },
    });
    let acked = 0;
    ingestor.submit(point(device, 1), () => acked++);
    await ingestor.flush();
    expect(acked).toBe(1);

    await sleep(120);
    await b.acquire(p); // another pod took the partition over
    ingestor.submit(point(device, 2), () => acked++);
    await expect(ingestor.flush()).rejects.toBeInstanceOf(FencedError);
    expect(lost).toEqual([[p]]);
    expect(acked).toBe(1);
    expect(ingestor.stats.fenced).toBe(1);
    expect(ingestor.stats.handedOff).toBe(1);
    expect(ingestor.stats.pending).toBe(0);
    const { rows } = await db.query<{ seq: number }>("SELECT seq FROM points ORDER BY seq");
    expect(rows.map((r) => Number(r.seq))).toEqual([1]);
    await ingestor.close();
  });
});
