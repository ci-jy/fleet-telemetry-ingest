import type { MqttClient } from "mqtt";
import type { Queryable } from "../db/db.js";
import type { Ingestor } from "../ingest/ingestor.js";
import { startSubscriber } from "../ingest/mqttSubscriber.js";
import { FencedError, type Lease, type LeaseStore } from "./leases.js";
import { partitionClientId, partitionFilter, partitionOf } from "./partition.js";

export interface CoordinatorOptions {
  partitions: number;
  /** Lease lifetime; a pod that cannot renew for this long loses its partitions. */
  leaseTtlMs: number;
  /** Renewal, membership heartbeat and rebalance interval. */
  renewEveryMs: number;
  /** Prefix of the per-partition MQTT client ids (`<prefix>-p<k>`). */
  clientIdPrefix: string;
  mqttUrl: string;
  sessionExpiryS: number;
  /** MQTT protocol of the partition sessions (5 by default; 4 for brokers without MQTT 5). */
  protocolVersion?: 4 | 5;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  log: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
}

export interface CoordinatorStats {
  owned: number;
  members: number;
  /** Partitions without a live owner, as last read from the lease table. */
  unowned: number;
  /** Longest time any partition has been without an owner (seconds, 0 if all are owned). */
  maxUnownedSeconds: number;
  acquisitions: number;
  releases: number;
  losses: number;
  /** Devices whose reorder buffers and trip state were rebuilt after gaining a partition. */
  devicesRebuilt: number;
  tickErrors: number;
}

interface Owned {
  lease: Lease;
  client: (MqttClient & { subscriberStats: unknown }) | null;
  renewedAt: number;
}

/**
 * Runs one ingest pod's share of the partitions.
 *
 * Every `renewEveryMs` it heartbeats its membership, renews its leases (a lease it cannot renew is
 * dropped at once), and moves towards its fair share `ceil(partitions / live members)`: it
 * releases surplus partitions gracefully and takes free or expired ones up to its share. Gaining a
 * partition rebuilds that partition's devices from the database and then opens the partition's
 * persistent MQTT session, which delivers whatever the broker queued while nobody owned it.
 */
export class PartitionCoordinator {
  private readonly owned = new Map<number, Owned>();
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private stopped = false;
  readonly stats: CoordinatorStats = {
    owned: 0,
    members: 0,
    unowned: 0,
    maxUnownedSeconds: 0,
    acquisitions: 0,
    releases: 0,
    losses: 0,
    devicesRebuilt: 0,
    tickErrors: 0,
  };

  constructor(
    private readonly ingestor: Ingestor,
    private readonly store: LeaseStore,
    private readonly opts: CoordinatorOptions,
  ) {}

  /** Fencing hook for the ingestor: every device of the batch must be in a partition held now. */
  readonly fence = async (tx: Queryable, deviceIds: ReadonlySet<string>): Promise<void> => {
    const leases = new Map<number, Lease>();
    for (const id of deviceIds) {
      const p = partitionOf(id, this.opts.partitions);
      if (leases.has(p)) continue;
      // A partition this pod no longer holds is checked with an impossible token, so it fails.
      leases.set(p, this.owned.get(p)?.lease ?? { partition: p, token: -1 });
    }
    await this.store.fence(tx, [...leases.values()]);
  };

  /** Called by the ingestor when a batch was fenced. */
  readonly onFenced = (err: { partitions: number[] }): void => {
    for (const p of err.partitions) this.lose(p, "fenced");
  };

  ownedPartitions(): number[] {
    return [...this.owned.keys()].sort((a, b) => a - b);
  }

  async start(): Promise<void> {
    await this.store.ensurePartitions(this.opts.partitions);
    await this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.renewEveryMs);
  }

  /** One renewal and rebalance round (never two at once). */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.round()
      .catch((err) => {
        this.stats.tickErrors++;
        this.opts.log("warn", "lease round failed", { error: String(err) });
        // Without the database nothing can be renewed: give up leases that may have expired.
        const now = Date.now();
        for (const [p, o] of this.owned) if (now - o.renewedAt >= this.opts.leaseTtlMs) this.lose(p, "renew timeout");
      })
      .finally(() => {
        this.ticking = null;
      });
    return this.ticking;
  }

  private async round(): Promise<void> {
    if (this.stopped) return;
    const members = await this.store.heartbeat();
    this.stats.members = members;
    const held = [...this.owned.values()].map((o) => o.lease);
    const startedAt = Date.now();
    const renewed = await this.store.renew(held);
    for (const lease of held) {
      const o = this.owned.get(lease.partition);
      if (!o || o.lease.token !== lease.token) continue;
      if (renewed.has(lease.partition)) o.renewedAt = startedAt;
      else this.lose(lease.partition, "not renewed");
    }

    const target = Math.ceil(this.opts.partitions / Math.max(1, members));
    if (this.owned.size > target) {
      const surplus = this.ownedPartitions().slice(target);
      for (const p of surplus) await this.release(p);
    } else if (this.owned.size < target) {
      const rows = await this.store.list();
      const free = rows.filter(
        (r) => !this.owned.has(r.partition) &&
          (r.owner === null || r.expiresInMs <= 0 || (r.holder === this.store.holder && r.owner !== this.store.owner)),
      );
      for (const r of free.slice(0, target - this.owned.size)) {
        if (this.stopped) break;
        const lease = await this.store.acquire(r.partition);
        if (lease) await this.gain(lease);
      }
    }
    this.updateUnowned(await this.store.list());
  }

  private updateUnowned(rows: Awaited<ReturnType<LeaseStore["list"]>>): void {
    const unowned = rows.filter((r) => r.owner === null || r.expiresInMs <= 0);
    this.stats.unowned = unowned.length;
    this.stats.maxUnownedSeconds = unowned.reduce((m, r) => Math.max(m, -r.expiresInMs / 1000), 0);
    this.stats.owned = this.owned.size;
  }

  private inPartition(p: number): (deviceId: string) => boolean {
    return (id) => partitionOf(id, this.opts.partitions) === p;
  }

  private async gain(lease: Lease): Promise<void> {
    const p = lease.partition;
    this.owned.set(p, { lease, client: null, renewedAt: Date.now() });
    this.stats.acquisitions++;
    this.stats.owned = this.owned.size;
    try {
      const rebuilt = await this.ingestor.recoverWhere(this.inPartition(p));
      this.stats.devicesRebuilt += rebuilt;
      const client = await startSubscriber(this.ingestor, {
        url: this.opts.mqttUrl,
        topic: partitionFilter(p),
        clientId: partitionClientId(this.opts.clientIdPrefix, p),
        protocolVersion: this.opts.protocolVersion ?? 5,
        sessionExpiryS: this.opts.sessionExpiryS,
        reconnectMinMs: this.opts.reconnectMinMs,
        reconnectMaxMs: this.opts.reconnectMaxMs,
        connectDeadlineMs: this.opts.leaseTtlMs,
        source: `p${p}`,
        log: (level, msg, extra) => this.opts.log(level, msg, { partition: p, ...extra }),
      });
      const o = this.owned.get(p);
      if (!o || o.lease.token !== lease.token) {
        // Lost while connecting.
        await client.endAsync(true).catch(() => undefined);
        this.ingestor.removeSource(`p${p}`);
        return;
      }
      o.client = client;
      this.opts.log("info", "partition acquired", { partition: p, token: lease.token, devicesRebuilt: rebuilt });
    } catch (err) {
      this.opts.log("warn", "could not start partition, releasing it", { partition: p, error: String(err) });
      this.lose(p, "start failed");
      await this.store.release(lease).catch(() => undefined);
    }
  }

  /**
   * Drops a partition at once: its queued messages are discarded unacknowledged (the broker
   * redelivers them to the next owner) and its session is closed without a clean DISCONNECT.
   */
  private lose(p: number, reason: string): void {
    this.ingestor.dropWhere(this.inPartition(p));
    const o = this.owned.get(p);
    if (!o) return;
    this.owned.delete(p);
    this.stats.losses++;
    this.stats.owned = this.owned.size;
    this.ingestor.removeSource(`p${p}`);
    o.client?.end(true);
    this.opts.log("warn", "partition lost", { partition: p, token: o.lease.token, reason });
  }

  /**
   * Hands a partition over: commits and acknowledges what is queued, closes the session, forgets
   * the partition and clears the lease so another pod can take it without waiting for expiry.
   */
  private async release(p: number): Promise<void> {
    const o = this.owned.get(p);
    if (!o) return;
    await this.ingestor.flush().catch(() => undefined);
    if (this.owned.get(p) !== o) return;
    await o.client?.endAsync(true).catch(() => undefined);
    this.owned.delete(p);
    this.ingestor.removeSource(`p${p}`);
    this.ingestor.dropWhere(this.inPartition(p));
    // Waits for any batch still holding the lease row (FOR SHARE) to commit.
    await this.store.release(o.lease);
    this.stats.releases++;
    this.stats.owned = this.owned.size;
    this.opts.log("info", "partition released", { partition: p, token: o.lease.token });
  }

  /**
   * Abrupt stop, as the rest of the cluster sees a crashed pod: no more renewals, every session
   * closed without a clean DISCONNECT, leases left to expire (or to the pod's next incarnation).
   */
  halt(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const [p, o] of [...this.owned]) {
      o.client?.end(true);
      this.ingestor.removeSource(`p${p}`);
      this.owned.delete(p);
    }
    this.stats.owned = 0;
  }

  /** Graceful stop, after the ingestor has drained: close every session and hand all leases back. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.ticking;
    for (const [p, o] of [...this.owned]) {
      if (o.client) await endWithin(o.client, 2_000);
      await this.store.release(o.lease).catch(() => undefined);
      this.owned.delete(p);
      this.stats.releases++;
    }
    this.stats.owned = 0;
    await this.store.leaveMembership().catch(() => undefined);
  }
}

/** Clean DISCONNECT, but never wait longer than `ms`: then the connection is dropped. */
async function endWithin(client: MqttClient, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<boolean>((r) => (timer = setTimeout(() => r(true), ms)));
  const ended = client.endAsync().then(() => false, () => false);
  if (await Promise.race([ended, timedOut])) client.end(true);
  clearTimeout(timer);
}

export { FencedError };
