import type { Queryable } from "../db/db.js";

/**
 * Partition leases with fencing tokens, stored in PostgreSQL (`partition_leases`).
 *
 * - `owner` identifies one incarnation of a pod (pod name plus a random suffix), `holder` the pod
 *   name alone. A restarted StatefulSet pod keeps its name, so it may take over the leases of its
 *   own previous incarnation at once instead of waiting for them to expire: that incarnation is
 *   known to be dead.
 * - Every change of owner increments `token`. Renewals keep it.
 * - `fence` runs inside each ingest transaction. It locks the batch's lease rows FOR SHARE and
 *   checks that they are still held with the expected token and unexpired, so a takeover (which
 *   updates the row) waits until the batch has committed and a stale owner can never commit.
 */

export interface Lease {
  partition: number;
  token: number;
}

export class FencedError extends Error {
  constructor(readonly partitions: number[]) {
    super(`lease lost for partition(s) ${partitions.join(",")}`);
    this.name = "FencedError";
  }
}

export interface LeaseRow {
  partition: number;
  owner: string | null;
  holder: string | null;
  token: number;
  expiresInMs: number;
}

export class LeaseStore {
  constructor(
    private readonly db: Queryable,
    readonly owner: string,
    readonly holder: string,
    readonly ttlMs: number,
  ) {}

  /** Creates the rows for partitions 0..n-1 (idempotent). */
  async ensurePartitions(n: number): Promise<void> {
    await this.db.query(
      `INSERT INTO partition_leases (partition, expires_at) SELECT g, now() FROM generate_series(0, $1::int - 1) g ON CONFLICT DO NOTHING`,
      [n],
    );
  }

  /** Takes a partition if it is free, expired, or held by a dead incarnation of this pod. */
  async acquire(partition: number): Promise<Lease | null> {
    const { rows } = await this.db.query<{ token: number }>(
      `UPDATE partition_leases
          SET owner = $2, holder = $3, token = token + 1,
              expires_at = now() + $4 * interval '1 millisecond', acquired_at = now(), updated_at = now()
        WHERE partition = $1
          AND (owner IS NULL OR expires_at <= now() OR (holder = $3 AND owner <> $2))
        RETURNING token`,
      [partition, this.owner, this.holder, this.ttlMs],
    );
    return rows[0] ? { partition, token: Number(rows[0].token) } : null;
  }

  /** Extends the leases still held with their tokens; returns the partitions that were renewed. */
  async renew(leases: readonly Lease[]): Promise<Set<number>> {
    if (leases.length === 0) return new Set();
    const { rows } = await this.db.query<{ partition: number }>(
      `UPDATE partition_leases l
          SET expires_at = now() + $2 * interval '1 millisecond', updated_at = now()
         FROM unnest($3::int[], $4::bigint[]) AS h(partition, token)
        WHERE l.partition = h.partition AND l.token = h.token AND l.owner = $1 AND l.expires_at > now()
        RETURNING l.partition`,
      [this.owner, this.ttlMs, leases.map((l) => l.partition), leases.map((l) => l.token)],
    );
    return new Set(rows.map((r) => Number(r.partition)));
  }

  /** Gives a partition up so another pod can take it immediately. */
  async release(lease: Lease): Promise<boolean> {
    const { rows } = await this.db.query<{ partition: number }>(
      `UPDATE partition_leases SET owner = NULL, holder = NULL, expires_at = now(), updated_at = now()
        WHERE partition = $1 AND owner = $2 AND token = $3 RETURNING partition`,
      [lease.partition, this.owner, lease.token],
    );
    return rows.length > 0;
  }

  /**
   * Fencing check, run inside a write transaction. Throws FencedError listing the partitions whose
   * lease is no longer held with the given token.
   */
  async fence(tx: Queryable, leases: readonly Lease[]): Promise<void> {
    if (leases.length === 0) return;
    const { rows } = await tx.query<{ partition: number; ok: boolean }>(
      `SELECT l.partition, (l.owner = $1 AND l.token = h.token AND l.expires_at > now()) AS ok
         FROM partition_leases l JOIN unnest($2::int[], $3::bigint[]) AS h(partition, token) ON l.partition = h.partition
        ORDER BY l.partition
          FOR SHARE OF l`,
      [this.owner, leases.map((l) => l.partition), leases.map((l) => l.token)],
    );
    const ok = new Set(rows.filter((r) => r.ok).map((r) => Number(r.partition)));
    const lost = leases.filter((l) => !ok.has(l.partition)).map((l) => l.partition);
    if (lost.length > 0) throw new FencedError(lost);
  }

  /** Records this pod as live and returns the number of live members (including this one). */
  async heartbeat(): Promise<number> {
    await this.db.query(
      `INSERT INTO ingest_members (member_id, expires_at) VALUES ($1, now() + $2 * interval '1 millisecond')
       ON CONFLICT (member_id) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
      [this.owner, this.ttlMs],
    );
    // Members of dead incarnations of this pod are not counted.
    const { rows } = await this.db.query<{ n: number }>(
      `SELECT count(*) AS n FROM ingest_members
        WHERE expires_at > now() AND (member_id = $1 OR member_id NOT LIKE $2)`,
      [this.owner, `${likeEscape(this.holder)}~%`],
    );
    return Number(rows[0]!.n);
  }

  async leaveMembership(): Promise<void> {
    await this.db.query(`DELETE FROM ingest_members WHERE member_id = $1`, [this.owner]);
  }

  /** All lease rows with the time left on each (negative when expired). */
  async list(): Promise<LeaseRow[]> {
    const { rows } = await this.db.query<LeaseRow>(
      `SELECT partition, owner, holder, token,
              (extract(epoch FROM (expires_at - now())) * 1000)::float8 AS "expiresInMs"
         FROM partition_leases ORDER BY partition`,
    );
    return rows.map((r) => ({ ...r, partition: Number(r.partition), token: Number(r.token), expiresInMs: Number(r.expiresInMs) }));
  }
}

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Owner id of one pod incarnation: `<pod name>~<random>`. */
export const ownerId = (holder: string, suffix: string): string => `${holder}~${suffix}`;
