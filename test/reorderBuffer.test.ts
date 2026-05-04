import { describe, expect, it } from "vitest";
import { ReorderBuffer } from "../src/domain/reorderBuffer.js";
import type { Telemetry } from "../src/domain/telemetry.js";

const msg = (seq: number, ts = seq * 1000): Telemetry => ({
  deviceId: "d",
  seq,
  ts,
  lat: 0,
  lon: 0,
  speedKph: 0,
  ignition: false,
});
const seqs = (ms: Telemetry[]) => ms.map((m) => m.seq);

describe("ReorderBuffer", () => {
  it("holds the very first message until the window passes (the stream may have started earlier)", () => {
    const b = new ReorderBuffer({ windowMs: 5000, maxBuffered: 100 });
    expect(seqs(b.offer(msg(10)).released)).toEqual([]);
    expect(seqs(b.offer(msg(9)).released)).toEqual([]);
    expect(seqs(b.offer(msg(15)).released)).toEqual([9, 10]);
  });

  it("releases contiguous sequences immediately once the cursor is set", () => {
    const b = new ReorderBuffer({ windowMs: 5000, maxBuffered: 100 }, { nextSeq: 1, maxTs: 0, buffered: [], skipped: [] });
    expect(seqs(b.offer(msg(1)).released)).toEqual([1]);
    expect(seqs(b.offer(msg(3)).released)).toEqual([]);
    expect(seqs(b.offer(msg(2)).released)).toEqual([2, 3]);
    expect(b.cursor).toBe(4);
  });

  it("skips a missing sequence once the head is older than the window", () => {
    const b = new ReorderBuffer({ windowMs: 5000, maxBuffered: 100 }, { nextSeq: 1, maxTs: 0, buffered: [], skipped: [] });
    b.offer(msg(1));
    expect(seqs(b.offer(msg(3)).released)).toEqual([]);
    expect(seqs(b.offer(msg(7)).released)).toEqual([]);
    expect(seqs(b.offer(msg(8)).released)).toEqual([3]); // 8s - 3s >= 5s
    expect(b.offer(msg(2)).outcome).toBe("late");
    expect(b.offer(msg(2)).outcome).toBe("duplicate");
  });

  it("detects duplicates that are buffered or already released", () => {
    const b = new ReorderBuffer({ windowMs: 5000, maxBuffered: 100 }, { nextSeq: 1, maxTs: 0, buffered: [], skipped: [] });
    b.offer(msg(1));
    b.offer(msg(3));
    expect(b.offer(msg(3)).outcome).toBe("duplicate");
    expect(b.offer(msg(1)).outcome).toBe("duplicate");
  });

  it("releases the oldest messages when full", () => {
    const b = new ReorderBuffer({ windowMs: 1e9, maxBuffered: 3 }, { nextSeq: 1, maxTs: 0, buffered: [], skipped: [] });
    for (const s of [5, 7, 9]) expect(b.offer(msg(s)).released).toEqual([]);
    expect(seqs(b.offer(msg(11)).released)).toEqual([5]);
    expect(b.size).toBe(3);
  });

  it("flush releases everything in order and clones are independent", () => {
    const b = new ReorderBuffer({ windowMs: 1e9, maxBuffered: 100 });
    for (const s of [4, 2, 9]) b.offer(msg(s));
    const c = b.clone();
    expect(seqs(b.flush())).toEqual([2, 4, 9]);
    expect(c.size).toBe(3);
    expect(seqs(c.flush())).toEqual([2, 4, 9]);
  });

  it("bounds the remembered holes after a huge sequence jump", () => {
    const b = new ReorderBuffer({ windowMs: 0, maxBuffered: 100 }, { nextSeq: 1, maxTs: 0, buffered: [], skipped: [] });
    b.offer(msg(1_000_000_000));
    expect(b.cursor).toBe(1_000_000_001);
    expect(b.snapshot().skipped.length).toBeLessThanOrEqual(512);
  });
});
