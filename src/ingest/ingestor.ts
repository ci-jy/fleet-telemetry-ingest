import type { Db, Queryable } from "../db/db.js";
import {
  insertPoints,
  insertTrip,
  loadReplayInput,
  markLate,
  pointKey,
  upsertDevices,
  type IncomingPoint,
} from "../db/repository.js";
import { ReorderBuffer, type ReorderConfig } from "../domain/reorderBuffer.js";
import { parseTelemetry, type Telemetry } from "../domain/telemetry.js";
import {
  DEFAULT_TRIP_CONFIG,
  initialTripState,
  step,
  type ClosedTrip,
  type DeviceTripState,
  type TripConfig,
} from "../domain/tripStateMachine.js";

export interface IngestorOptions {
  trip: TripConfig;
  reorder: ReorderConfig;
  /** Flush a batch once this many messages are pending... */
  batchMaxSize: number;
  /** ...or once the oldest pending message has waited this long. */
  batchMaxDelayMs: number;
  /** Release a device's reorder buffer if no message arrived for it for this long (wall clock). */
  staleFlushMs: number;
  /** Retry delay after a failed batch; doubles on each consecutive failure... */
  retryDelayMs: number;
  /** ...up to this cap. */
  retryMaxDelayMs: number;
  /**
   * Bound on messages held in memory waiting for a batch. At this depth the ingestor reports
   * itself saturated and the MQTT consumer stops reading until the queue is half empty.
   */
  maxPending: number;
  now: () => number;
  /** Partition count of partitioned topics; a message on the wrong partition is rejected. */
  partitions?: number;
  /**
   * Runs first inside every batch transaction with the devices the batch writes. Throws a
   * `FencedError` (from the lease module) if this process no longer owns some of them.
   */
  fence?: (tx: Queryable, deviceIds: ReadonlySet<string>) => Promise<void>;
  /** Called when a batch was refused by `fence`; the owner of the lost partitions drops them. */
  onFenced?: (err: Error & { partitions: number[] }) => void;
  /** Called after each commit with the committed messages (for latency metrics). */
  onCommit?: (points: readonly CommittedPoint[], committedAt: number) => void;
  log: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
}

export const DEFAULT_INGESTOR_OPTIONS: IngestorOptions = {
  trip: DEFAULT_TRIP_CONFIG,
  reorder: { windowMs: 30_000, maxBuffered: 500 },
  batchMaxSize: 1000,
  batchMaxDelayMs: 20,
  staleFlushMs: 15_000,
  retryDelayMs: 500,
  retryMaxDelayMs: 5_000,
  maxPending: 10_000,
  now: () => Date.now(),
  log: () => undefined,
};

export interface IngestStats {
  received: number;
  invalid: number;
  stored: number;
  duplicates: number;
  late: number;
  applied: number;
  tripsClosed: number;
  batches: number;
  batchErrors: number;
  pending: number;
  /** Capacity of the in-memory queue (`maxPending`). */
  queueCapacity: number;
  /** Highest queue depth since start. */
  queuePeak: number;
  /** True while the consumer is paused because the queue is full. */
  paused: boolean;
  /** Number of times consumption was paused. */
  pauses: number;
  /** Failed batches in a row (0 when the database is healthy). */
  consecutiveFailures: number;
  /** Devices whose in-memory state was rebuilt from the database after a failed batch. */
  reloads: number;
  /** Messages held in reorder buffers, waiting for a missing sequence number. */
  buffered: number;
  /** Whether the message source (MQTT) is connected. */
  sourceConnected: boolean;
  devices: number;
  lastBatchMs: number;
  lastError: string | null;
  /** Batches refused because a partition lease was lost. */
  fenced: number;
  /** Queued messages dropped (unacknowledged) because their partition moved to another pod. */
  handedOff: number;
}

export interface CommittedPoint {
  /** Wall-clock arrival time (ms). */
  receivedAt: number;
  /** Publisher's wall-clock send time (ms), when the publisher reported it. */
  publishedAt?: number;
}

/** A queued message plus the callback that acknowledges it to the broker once it is committed. */
interface PendingPoint extends IncomingPoint {
  ack?: () => void;
  publishedAt?: number;
}

interface DeviceRuntime {
  buffer: ReorderBuffer;
  trip: DeviceTripState;
  lastArrival: number;
}

/**
 * Turns validated telemetry into stored points, trips and idle segments.
 *
 * Messages are collected into small batches. Each batch is handled in one database transaction:
 * raw points are inserted idempotently, the new ones go through each device's reorder buffer and
 * trip state machine, and the resulting trips, idle segments and device states are written. The
 * in-memory device state is computed on copies and only swapped in after COMMIT, so a failed
 * transaction leaves memory and database consistent and the batch can simply be retried.
 *
 * A failure whose outcome is unknown (for example the connection dropped while COMMIT was in
 * flight) may still have committed. The devices of a failed batch are therefore rebuilt from the
 * database before the retry; the retry then sees its own rows as duplicates and changes nothing.
 *
 * Messages carry an optional `ack` callback that runs only after their batch has committed, so
 * the broker keeps (and redelivers) anything that was not yet durable when the process died.
 */
export class Ingestor {
  private readonly opts: IngestorOptions;
  private readonly devices = new Map<string, DeviceRuntime>();
  private pending: PendingPoint[] = [];
  private forceFlush = new Set<string>();
  /** Devices whose in-memory state may be stale after a failed batch. */
  private dirty = new Set<string>();
  private readyWaiters: (() => void)[] = [];
  private sourceConnected = true;
  /** Connection state per message source (one per MQTT session); healthy only if all are up. */
  private readonly sources = new Map<string, boolean>();
  /** Wall-clock time since which the pipeline has been healthy (consumer connected, database up). */
  private healthySince = 0;
  private timer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  /** A timer-driven flush is waiting in the chain; another one would add nothing. */
  private flushQueued = false;
  /** Earliest time (performance.now()) a timer-driven flush may retry after a failure. */
  private retryAt = 0;
  private closed = false;
  private readonly listeners = new Set<(trip: ClosedTrip & { deviceId: string }) => void>();
  readonly stats: IngestStats = {
    received: 0,
    invalid: 0,
    stored: 0,
    duplicates: 0,
    late: 0,
    applied: 0,
    tripsClosed: 0,
    batches: 0,
    batchErrors: 0,
    pending: 0,
    queueCapacity: 0,
    queuePeak: 0,
    paused: false,
    pauses: 0,
    consecutiveFailures: 0,
    reloads: 0,
    buffered: 0,
    sourceConnected: true,
    devices: 0,
    lastBatchMs: 0,
    lastError: null,
    fenced: 0,
    handedOff: 0,
  };

  constructor(
    private readonly db: Db,
    options: Partial<IngestorOptions> = {},
  ) {
    this.opts = { ...DEFAULT_INGESTOR_OPTIONS, ...options };
    this.stats.queueCapacity = this.opts.maxPending;
    this.healthySince = this.opts.now();
  }

  /** Rebuilds every known device's state by replaying its stored points since its last persisted trip. */
  async recover(): Promise<number> {
    return this.recoverWhere(() => true);
  }

  /**
   * Rebuilds the state of the stored devices matching `owned` (the devices of partitions this
   * process just gained), exactly as a restart would.
   */
  async recoverWhere(owned: (deviceId: string) => boolean): Promise<number> {
    const { rows } = await this.db.query<{ device_id: string }>(
      `SELECT device_id FROM devices UNION SELECT DISTINCT device_id FROM points`,
    );
    const mine = rows.filter((r) => owned(r.device_id));
    for (const { device_id } of mine) await this.recoverDevice(this.db, device_id);
    this.stats.devices = this.devices.size;
    this.stats.buffered = [...this.devices.values()].reduce((n, d) => n + d.buffer.size, 0);
    return mine.length;
  }

  /**
   * Forgets the devices matching `lost` (their partition moved to another process): queued
   * messages are dropped without acknowledgement, so the broker redelivers them to the new owner,
   * and their in-memory state is discarded. The stored rows are the new owner's starting point.
   */
  dropWhere(lost: (deviceId: string) => boolean): number {
    const before = this.pending.length;
    this.pending = this.pending.filter((p) => !lost(p.msg.deviceId));
    const dropped = before - this.pending.length;
    for (const id of [...this.devices.keys()]) if (lost(id)) this.devices.delete(id);
    for (const id of [...this.forceFlush]) if (lost(id)) this.forceFlush.delete(id);
    for (const id of [...this.dirty]) if (lost(id)) this.dirty.delete(id);
    this.stats.handedOff += dropped;
    this.stats.pending = this.pending.length;
    this.stats.devices = this.devices.size;
    this.stats.buffered = [...this.devices.values()].reduce((n, d) => n + d.buffer.size, 0);
    this.releaseWaiters();
    return dropped;
  }

  /**
   * Rebuilds one device from the database: trip state from its last persisted trip plus the
   * points the reorder buffer had released, and the buffer itself from the points it still held.
   */
  private async recoverDevice(db: Queryable, deviceId: string): Promise<void> {
    const input = await loadReplayInput(db, deviceId);
    let state: DeviceTripState = initialTripState();
    if (input.lastTrip) {
      // Same state the live state machine is in right after closing that trip.
      const end = input.lastTrip.endReason === "gap" ? null : input.lastTrip.endPoint;
      state = { state: "trip_ended", last: end, trip: null, anchor: end };
    }
    // Without a stored cursor (rows written by an older version) every stored point is replayed.
    const cursor = input.nextSeq;
    const applied = cursor === undefined ? input.points : cursor === null ? [] : input.points.filter((p) => p.seq < cursor);
    const closed: ClosedTrip[] = [];
    for (const p of applied) {
      const r = step(state, p, this.opts.trip);
      state = r.state;
      for (const e of r.events) if (e.type === "trip_ended") closed.push(e.trip);
    }
    // Trips closed during replay were already persisted unless a crash hit between storing the
    // points and storing the trip; insertTrip is idempotent, so write them to be sure.
    if (closed.length > 0) {
      await this.db.transaction(async (tx) => {
        for (const t of closed) await insertTrip(tx, deviceId, t);
      });
    }
    const buffer =
      cursor === undefined
        ? new ReorderBuffer(this.opts.reorder, {
            nextSeq: input.maxSeq === null ? null : input.maxSeq + 1,
            maxTs: state.last?.ts ?? 0,
            buffered: [],
            skipped: [],
          })
        : new ReorderBuffer(this.opts.reorder, {
            nextSeq: cursor,
            maxTs: input.maxTs,
            // Points stored after the trip's end are a superset of what is still buffered: anything
            // below the cursor was released, anything at or above it was waiting for a gap to fill.
            buffered: input.points
              .filter((p) => cursor === null || p.seq >= cursor)
              .map((p) => ({ deviceId, ...p })),
            // Holes only decide between "late" and "duplicate"; both are refused, so none are needed.
            skipped: [],
          });
    this.devices.set(deviceId, {
      buffer,
      trip: state,
      lastArrival: this.opts.now(),
    });
  }

  /** Starts the periodic sweep that releases reorder buffers of devices that went quiet. */
  start(): void {
    if (this.staleTimer) return;
    const every = Math.max(250, Math.min(this.opts.staleFlushMs / 2, 5_000));
    this.staleTimer = setInterval(() => this.sweepStale(), every);
    this.staleTimer.unref();
  }

  onTripClosed(fn: (trip: ClosedTrip & { deviceId: string }) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Entry point for raw MQTT messages. Returns false if the message was rejected as invalid.
   * `ack` runs once the message is durable: after its batch commits, or at once if it is invalid
   * (an invalid message will never become valid, so there is no point in redelivering it).
   */
  submitRaw(topic: string, payload: Buffer | string, ack?: () => void, publishedAt?: number): boolean {
    this.stats.received++;
    const parsed = parseTelemetry(topic, payload, this.opts.partitions);
    if (!parsed.ok) {
      this.stats.invalid++;
      this.opts.log("warn", "rejected message", { topic, error: parsed.error });
      ack?.();
      return false;
    }
    this.enqueue(parsed.msg, ack, publishedAt);
    return true;
  }

  /** Entry point for already-validated messages. */
  submit(msg: Telemetry, ack?: () => void): void {
    this.stats.received++;
    this.enqueue(msg, ack);
  }

  /** True once `close()` or `shutdown()` was called; no further messages are accepted. */
  get isClosed(): boolean {
    return this.closed;
  }

  /** True while the in-memory queue is full; the consumer should stop reading until `whenReady()`. */
  get saturated(): boolean {
    return this.pending.length >= this.opts.maxPending;
  }

  /** Resolves once the queue has drained to half its capacity (immediately if it is not full). */
  whenReady(): Promise<void> {
    if (!this.stats.paused && !this.saturated) return Promise.resolve();
    if (!this.stats.paused) {
      this.stats.paused = true;
      this.stats.pauses++;
      this.opts.log("warn", "queue full, pausing consumer", { depth: this.pending.length });
    }
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  /** Tells the ingestor whether its message source is connected (used to judge pipeline health). */
  setSourceConnected(connected: boolean, source = "default"): void {
    this.sources.set(source, connected);
    connected = [...this.sources.values()].every(Boolean);
    if (connected && !this.sourceConnected && this.stats.consecutiveFailures === 0) this.healthySince = this.opts.now();
    this.sourceConnected = connected;
    this.stats.sourceConnected = connected;
  }

  private releaseWaiters(): void {
    if (!this.stats.paused || this.pending.length > this.opts.maxPending / 2) return;
    this.stats.paused = false;
    this.opts.log("info", "queue drained, resuming consumer", { depth: this.pending.length });
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w();
  }

  /** Removes a message source (an MQTT session that was closed on purpose). */
  removeSource(source: string): void {
    this.sources.delete(source);
    const connected = [...this.sources.values()].every(Boolean);
    if (connected && !this.sourceConnected && this.stats.consecutiveFailures === 0) this.healthySince = this.opts.now();
    this.sourceConnected = connected;
    this.stats.sourceConnected = connected;
  }

  private enqueue(msg: Telemetry, ack?: () => void, publishedAt?: number): void {
    if (this.closed) throw new Error("ingestor is closed");
    this.pending.push({ msg, receivedAt: this.opts.now(), ack, publishedAt });
    this.stats.pending = this.pending.length;
    if (this.pending.length > this.stats.queuePeak) this.stats.queuePeak = this.pending.length;
    if (this.pending.length >= this.opts.batchMaxSize) {
      this.schedule(0);
    } else {
      this.schedule(this.opts.batchMaxDelayMs);
    }
  }

  private schedule(delayMs: number): void {
    // While a failed batch waits for its retry, new arrivals must not bring the retry forward.
    if (this.timer && (delayMs > 0 || this.stats.consecutiveFailures > 0)) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scheduledFlush();
    }, delayMs);
  }

  /** Processes everything pending. Resolves when the batches queued so far are committed. */
  flush(): Promise<void> {
    const run = this.chain.then(() => this.processPending());
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Flush triggered by the batch or retry timer. While a slow batch runs, the batch timer keeps
   * firing; those triggers are coalesced into one, and after a failure they wait for the backoff.
   */
  private scheduledFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    const run = this.chain.then(() => {
      this.flushQueued = false;
      if (this.stats.consecutiveFailures > 0 && performance.now() < this.retryAt - 5) return;
      return this.processPending();
    });
    this.chain = run.catch(() => undefined);
  }

  /** Waits until all pending messages are stored, then releases every reorder buffer. */
  async drain(): Promise<void> {
    await this.flush();
    for (const [id, d] of this.devices) if (d.buffer.size > 0) this.forceFlush.add(id);
    await this.flush();
  }

  async close(): Promise<void> {
    this.stopTimers();
    await this.drain();
  }

  /**
   * Graceful stop: refuses new messages and commits (and acknowledges) everything already queued.
   * Unlike `close()` it does not release the reorder buffers: the points they hold are stored, and
   * the next start rebuilds the buffers from them, so the outcome is the same as never stopping.
   * Gives up after `timeoutMs`; whatever is still uncommitted was never acknowledged and will be
   * redelivered by the broker.
   */
  async shutdown(timeoutMs = 10_000): Promise<{ drained: boolean; pending: number }> {
    this.stopTimers();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), timeoutMs)));
    let gaveUp = false;
    const attempt = async (): Promise<"ok" | "timeout"> => {
      while (!gaveUp) {
        try {
          await this.flush();
          if (this.pending.length === 0) return "ok";
        } catch {
          await new Promise((r) => setTimeout(r, this.opts.retryDelayMs));
        }
      }
      return "timeout";
    };
    const outcome = await Promise.race([attempt(), deadline]);
    gaveUp = true;
    clearTimeout(timer);
    return { drained: outcome === "ok", pending: this.pending.length };
  }

  private stopTimers(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.timer = null;
    this.staleTimer = null;
  }

  /** Current in-memory state of a device (for diagnostics and tests). */
  deviceState(deviceId: string): DeviceTripState | undefined {
    return this.devices.get(deviceId)?.trip;
  }

  private sweepStale(): void {
    // Silence caused by our own outage (broker unreachable, database failing, consumer paused) says
    // nothing about the devices, so quiet time only counts while the pipeline is healthy.
    if (!this.sourceConnected || this.stats.consecutiveFailures > 0 || this.stats.paused) return;
    const now = this.opts.now();
    let any = false;
    for (const [id, d] of this.devices) {
      if (d.buffer.size > 0 && now - Math.max(d.lastArrival, this.healthySince) >= this.opts.staleFlushMs) {
        this.forceFlush.add(id);
        any = true;
      }
    }
    if (any) this.schedule(0);
  }

  private async processPending(): Promise<void> {
    while (this.pending.length > 0 || this.forceFlush.size > 0) {
      const batch = this.pending.splice(0, this.opts.batchMaxSize);
      const force = this.forceFlush;
      this.forceFlush = new Set();
      try {
        await this.reloadDirty();
        await this.processBatch(batch, force);
        if (this.stats.consecutiveFailures > 0) {
          this.opts.log("info", "database recovered", { failures: this.stats.consecutiveFailures });
          this.stats.consecutiveFailures = 0;
          this.healthySince = this.opts.now();
        }
        for (const p of batch) p.ack?.();
      } catch (err) {
        if (err instanceof Error && err.name === "FencedError") {
          // This process lost some partitions. Nothing was written (the fence runs first in the
          // transaction); the owner drops the lost partitions' messages, the rest goes again.
          this.pending = batch.concat(this.pending);
          for (const id of force) this.forceFlush.add(id);
          this.stats.fenced++;
          this.opts.log("warn", "batch fenced, partition lease lost", { error: err.message });
          this.opts.onFenced?.(err as Error & { partitions: number[] });
          if (!this.closed) this.schedule(0);
          throw err;
        }
        // In-memory state is unchanged. The transaction most likely rolled back, but if the failure
        // hit while COMMIT was in flight it may have committed: rebuild the batch's devices from the
        // database before the retry, which then sees its own rows as duplicates.
        this.pending = batch.concat(this.pending);
        for (const id of force) this.forceFlush.add(id);
        for (const p of batch) this.dirty.add(p.msg.deviceId);
        for (const id of force) this.dirty.add(id);
        this.stats.batchErrors++;
        this.stats.consecutiveFailures++;
        this.stats.lastError = err instanceof Error ? err.message : String(err);
        const delay = Math.min(
          this.opts.retryMaxDelayMs,
          this.opts.retryDelayMs * 2 ** Math.min(this.stats.consecutiveFailures - 1, 16),
        );
        this.retryAt = performance.now() + delay;
        this.opts.log("error", "batch failed, will retry", { error: this.stats.lastError, size: batch.length, retryInMs: delay });
        if (!this.closed) {
          if (this.timer) clearTimeout(this.timer);
          this.timer = setTimeout(() => {
            this.timer = null;
            this.scheduledFlush();
          }, delay);
        }
        throw err;
      } finally {
        this.stats.pending = this.pending.length;
        this.releaseWaiters();
      }
    }
  }

  private async reloadDirty(): Promise<void> {
    for (const id of [...this.dirty]) {
      await this.recoverDevice(this.db, id);
      this.dirty.delete(id);
      this.stats.reloads++;
    }
    this.stats.devices = this.devices.size;
  }

  private async processBatch(batch: PendingPoint[], force: Set<string>): Promise<void> {
    const started = performance.now();
    // Drop exact redeliveries inside the batch before touching the database.
    const seen = new Set<string>();
    const unique: IncomingPoint[] = [];
    for (const p of batch) {
      const k = pointKey(p.msg.deviceId, p.msg.seq);
      if (seen.has(k)) continue;
      seen.add(k);
      unique.push(p);
    }
    let inBatchDuplicates = batch.length - unique.length;

    const result = await this.db.transaction(async (tx) => {
      if (this.opts.fence) {
        const ids = new Set(unique.map((p) => p.msg.deviceId));
        for (const id of force) ids.add(id);
        await this.opts.fence(tx, ids);
      }
      const fresh = await insertPoints(tx, unique);
      const working = new Map<string, DeviceRuntime>();
      const touch = (deviceId: string): DeviceRuntime => {
        let w = working.get(deviceId);
        if (!w) {
          const cur = this.devices.get(deviceId);
          w = cur
            ? { buffer: cur.buffer.clone(), trip: cur.trip, lastArrival: cur.lastArrival }
            : { buffer: new ReorderBuffer(this.opts.reorder), trip: initialTripState(), lastArrival: 0 };
          working.set(deviceId, w);
        }
        return w;
      };

      const late: { deviceId: string; seq: number }[] = [];
      const closedTrips: { deviceId: string; trip: ClosedTrip }[] = [];
      let applied = 0;
      const apply = (deviceId: string, w: DeviceRuntime, msgs: Telemetry[]): void => {
        for (const m of msgs) {
          const r = step(w.trip, m, this.opts.trip);
          w.trip = r.state;
          applied++;
          for (const e of r.events) if (e.type === "trip_ended") closedTrips.push({ deviceId, trip: e.trip });
        }
      };

      for (const p of unique) {
        if (!fresh.has(pointKey(p.msg.deviceId, p.msg.seq))) continue;
        const w = touch(p.msg.deviceId);
        w.lastArrival = p.receivedAt;
        const r = w.buffer.offer(p.msg);
        // The database already proved this message is new, so anything the buffer refuses
        // arrived after its slot was released: it is late, not a duplicate.
        if (r.outcome !== "accepted") late.push({ deviceId: p.msg.deviceId, seq: p.msg.seq });
        apply(p.msg.deviceId, w, r.released);
      }
      for (const id of force) {
        const w = touch(id);
        apply(id, w, w.buffer.flush());
      }

      await markLate(tx, late);
      for (const c of closedTrips) await insertTrip(tx, c.deviceId, c.trip);
      await upsertDevices(
        tx,
        [...working].map(([deviceId, w]) => ({ deviceId, state: w.trip, nextSeq: w.buffer.cursor })),
      );
      return { fresh: fresh.size, late: late.length, applied, closedTrips, working };
    });

    for (const [id, w] of result.working) this.devices.set(id, w);
    this.opts.onCommit?.(batch, Date.now());
    inBatchDuplicates += unique.length - result.fresh;
    this.stats.batches++;
    this.stats.stored += result.fresh;
    this.stats.duplicates += inBatchDuplicates;
    this.stats.late += result.late;
    this.stats.applied += result.applied;
    this.stats.tripsClosed += result.closedTrips.length;
    this.stats.devices = this.devices.size;
    let buffered = 0;
    for (const d of this.devices.values()) buffered += d.buffer.size;
    this.stats.buffered = buffered;
    this.stats.lastBatchMs = performance.now() - started;
    for (const c of result.closedTrips) for (const fn of this.listeners) fn({ deviceId: c.deviceId, ...c.trip });
  }
}
