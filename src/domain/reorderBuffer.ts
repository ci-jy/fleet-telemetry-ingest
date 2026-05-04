import type { Telemetry } from "./telemetry.js";

export interface ReorderConfig {
  /** Hold a message at most this long in event time (relative to the newest event seen) waiting for gaps to fill. */
  windowMs: number;
  /** Hard cap on buffered messages per device; the oldest is released when exceeded. */
  maxBuffered: number;
}

export type OfferOutcome = "accepted" | "duplicate" | "late";

export interface OfferResult {
  outcome: OfferOutcome;
  /** Messages released in ascending `seq` order, ready for the state machine. */
  released: Telemetry[];
}

export interface ReorderSnapshot {
  nextSeq: number | null;
  maxTs: number;
  buffered: Telemetry[];
  skipped: number[];
}

/** Holes we remember so a straggler can be classified as "late" rather than "duplicate". */
const MAX_SKIPPED_REMEMBERED = 512;

/**
 * Per-device reorder buffer keyed by sequence number.
 *
 * Messages are released strictly in ascending `seq` order. A message is released as soon as
 * it is the next expected sequence number. If a sequence number never arrives (dropout), the
 * buffer gives up on it once the head message is older than `windowMs` relative to the newest
 * event time seen, or when the buffer is full, or on an explicit flush. Any message whose `seq`
 * is below the release cursor afterwards is reported as `late` (if it fills a hole we skipped)
 * or `duplicate` (if it was already released or is already buffered).
 */
export class ReorderBuffer {
  private nextSeq: number | null;
  private maxTs: number;
  private buffered: Telemetry[]; // sorted by seq ascending
  private skipped: Set<number>;

  constructor(
    private readonly config: ReorderConfig,
    snapshot?: ReorderSnapshot,
  ) {
    this.nextSeq = snapshot?.nextSeq ?? null;
    this.maxTs = snapshot?.maxTs ?? 0;
    this.buffered = snapshot ? [...snapshot.buffered] : [];
    this.skipped = new Set(snapshot?.skipped ?? []);
  }

  clone(): ReorderBuffer {
    return new ReorderBuffer(this.config, this.snapshot());
  }

  snapshot(): ReorderSnapshot {
    return {
      nextSeq: this.nextSeq,
      maxTs: this.maxTs,
      buffered: [...this.buffered],
      skipped: [...this.skipped],
    };
  }

  get size(): number {
    return this.buffered.length;
  }

  /** The next sequence number the buffer is waiting for (null before the first release). */
  get cursor(): number | null {
    return this.nextSeq;
  }

  offer(msg: Telemetry): OfferResult {
    if (this.nextSeq !== null && msg.seq < this.nextSeq) {
      if (this.skipped.delete(msg.seq)) return { outcome: "late", released: [] };
      return { outcome: "duplicate", released: [] };
    }
    const idx = this.insertionIndex(msg.seq);
    if (this.buffered[idx]?.seq === msg.seq) return { outcome: "duplicate", released: [] };
    this.buffered.splice(idx, 0, msg);
    if (msg.ts > this.maxTs) this.maxTs = msg.ts;
    return { outcome: "accepted", released: this.drain(false) };
  }

  /** Releases everything buffered, skipping over any holes. */
  flush(): Telemetry[] {
    return this.drain(true);
  }

  private drain(force: boolean): Telemetry[] {
    const out: Telemetry[] = [];
    while (this.buffered.length > 0) {
      const head = this.buffered[0]!;
      const contiguous = this.nextSeq === null ? false : head.seq === this.nextSeq;
      const expired = this.maxTs - head.ts >= this.config.windowMs;
      const overflow = this.buffered.length > this.config.maxBuffered;
      if (!(contiguous || expired || overflow || force)) break;
      this.buffered.shift();
      if (this.nextSeq !== null) {
        const from = Math.max(this.nextSeq, head.seq - MAX_SKIPPED_REMEMBERED);
        for (let s = from; s < head.seq; s++) this.rememberSkipped(s);
      }
      this.nextSeq = head.seq + 1;
      out.push(head);
    }
    return out;
  }

  private rememberSkipped(seq: number): void {
    this.skipped.add(seq);
    if (this.skipped.size > MAX_SKIPPED_REMEMBERED) {
      const oldest = Math.min(...this.skipped);
      this.skipped.delete(oldest);
    }
  }

  private insertionIndex(seq: number): number {
    let lo = 0;
    let hi = this.buffered.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.buffered[mid]!.seq < seq) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}
