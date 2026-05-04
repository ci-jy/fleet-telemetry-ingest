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
  /** Retry delay after a failed batch. */
  retryDelayMs: number;
  now: () => number;
  log: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
}

export const DEFAULT_INGESTOR_OPTIONS: IngestorOptions = {
  trip: DEFAULT_TRIP_CONFIG,
  reorder: { windowMs: 30_000, maxBuffered: 500 },
  batchMaxSize: 1000,
  batchMaxDelayMs: 20,
  staleFlushMs: 15_000,
  retryDelayMs: 500,
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
  devices: number;
  lastBatchMs: number;
  lastError: string | null;
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
 */
export class Ingestor {
  private readonly opts: IngestorOptions;
  private readonly devices = new Map<string, DeviceRuntime>();
  private pending: IncomingPoint[] = [];
  private forceFlush = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
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
    devices: 0,
    lastBatchMs: 0,
    lastError: null,
  };

  constructor(
    private readonly db: Db,
    options: Partial<IngestorOptions> = {},
  ) {
    this.opts = { ...DEFAULT_INGESTOR_OPTIONS, ...options };
  }

  /** Rebuilds every known device's state by replaying its stored points since its last persisted trip. */
  async recover(): Promise<number> {
    const { rows } = await this.db.query<{ device_id: string }>(
      `SELECT device_id FROM devices UNION SELECT DISTINCT device_id FROM points`,
    );
    for (const { device_id } of rows) await this.recoverDevice(this.db, device_id);
    this.stats.devices = this.devices.size;
    return rows.length;
  }

  private async recoverDevice(db: Queryable, deviceId: string): Promise<void> {
    const input = await loadReplayInput(db, deviceId);
    let state: DeviceTripState = initialTripState();
    if (input.lastTrip) {
      state = {
        state: "trip_ended",
        last: input.lastTrip.endReason === "gap" ? null : input.lastTrip.endPoint,
        trip: null,
      };
    }
    const closed: ClosedTrip[] = [];
    for (const p of input.points) {
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
    this.devices.set(deviceId, {
      buffer: new ReorderBuffer(this.opts.reorder, {
        nextSeq: input.maxSeq === null ? null : input.maxSeq + 1,
        maxTs: state.last?.ts ?? 0,
        buffered: [],
        skipped: [],
      }),
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

  /** Entry point for raw MQTT messages. Returns false if the message was rejected as invalid. */
  submitRaw(topic: string, payload: Buffer | string): boolean {
    this.stats.received++;
    const parsed = parseTelemetry(topic, payload);
    if (!parsed.ok) {
      this.stats.invalid++;
      this.opts.log("warn", "rejected message", { topic, error: parsed.error });
      return false;
    }
    this.enqueue(parsed.msg);
    return true;
  }

  /** Entry point for already-validated messages. */
  submit(msg: Telemetry): void {
    this.stats.received++;
    this.enqueue(msg);
  }

  private enqueue(msg: Telemetry): void {
    if (this.closed) throw new Error("ingestor is closed");
    this.pending.push({ msg, receivedAt: this.opts.now() });
    this.stats.pending = this.pending.length;
    if (this.pending.length >= this.opts.batchMaxSize) {
      this.schedule(0);
    } else {
      this.schedule(this.opts.batchMaxDelayMs);
    }
  }

  private schedule(delayMs: number): void {
    if (this.timer && delayMs > 0) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => undefined);
    }, delayMs);
  }

  /** Processes everything pending. Resolves when the batches queued so far are committed. */
  flush(): Promise<void> {
    const run = this.chain.then(() => this.processPending());
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Waits until all pending messages are stored, then releases every reorder buffer. */
  async drain(): Promise<void> {
    await this.flush();
    for (const [id, d] of this.devices) if (d.buffer.size > 0) this.forceFlush.add(id);
    await this.flush();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.timer = null;
    this.staleTimer = null;
    await this.drain();
  }

  /** Current in-memory state of a device (for diagnostics and tests). */
  deviceState(deviceId: string): DeviceTripState | undefined {
    return this.devices.get(deviceId)?.trip;
  }

  private sweepStale(): void {
    const now = this.opts.now();
    let any = false;
    for (const [id, d] of this.devices) {
      if (d.buffer.size > 0 && now - d.lastArrival >= this.opts.staleFlushMs) {
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
        await this.processBatch(batch, force);
      } catch (err) {
        // Nothing was committed and no in-memory state changed: put the work back and retry later.
        this.pending = batch.concat(this.pending);
        for (const id of force) this.forceFlush.add(id);
        this.stats.batchErrors++;
        this.stats.lastError = err instanceof Error ? err.message : String(err);
        this.opts.log("error", "batch failed, will retry", { error: this.stats.lastError, size: batch.length });
        if (!this.closed) {
          if (this.timer) clearTimeout(this.timer);
          this.timer = setTimeout(() => {
            this.timer = null;
            this.flush().catch(() => undefined);
          }, this.opts.retryDelayMs);
        }
        throw err;
      } finally {
        this.stats.pending = this.pending.length;
      }
    }
  }

  private async processBatch(batch: IncomingPoint[], force: Set<string>): Promise<void> {
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
        [...working].map(([deviceId, w]) => ({ deviceId, state: w.trip })),
      );
      return { fresh: fresh.size, late: late.length, applied, closedTrips, working };
    });

    for (const [id, w] of result.working) this.devices.set(id, w);
    inBatchDuplicates += unique.length - result.fresh;
    this.stats.batches++;
    this.stats.stored += result.fresh;
    this.stats.duplicates += inBatchDuplicates;
    this.stats.late += result.late;
    this.stats.applied += result.applied;
    this.stats.tripsClosed += result.closedTrips.length;
    this.stats.devices = this.devices.size;
    this.stats.lastBatchMs = performance.now() - started;
    for (const c of result.closedTrips) for (const fn of this.listeners) fn({ deviceId: c.deviceId, ...c.trip });
  }
}
