import pg from "pg";

export interface QueryResult<T> {
  rows: T[];
}

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/** Minimal database abstraction so the same code runs on node-postgres and on in-process PGlite (tests). */
export interface Db extends Queryable {
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// Return int8/numeric as JS numbers; sequence numbers and counts stay well inside 2^53.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));

export interface PgOptions {
  max?: number;
  /** Give up acquiring a new connection after this long (a partitioned server never answers). */
  connectTimeoutMs?: number;
  /** Fail a query that has not answered after this long; its connection is then discarded. */
  queryTimeoutMs?: number;
}

export function createPgDb(connectionString: string, opts: PgOptions = {}): Db {
  const pool = new pg.Pool({
    connectionString,
    max: opts.max ?? 10,
    connectionTimeoutMillis: opts.connectTimeoutMs ?? 5_000,
    query_timeout: opts.queryTimeoutMs ?? 15_000,
    keepAlive: true,
  });
  // An idle client whose server went away emits 'error' on the pool; without a listener that
  // would crash the process. The pool drops the client and the next query opens a new one.
  pool.on("error", () => undefined);
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const r = await pool.query(sql, params as unknown[]);
      return { rows: r.rows as T[] };
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let broken: Error | undefined;
      try {
        await client.query("BEGIN");
        const tx: Queryable = {
          async query<R>(sql: string, params?: unknown[]) {
            const r = await client.query(sql, params as unknown[]);
            return { rows: r.rows as R[] };
          },
        };
        const out = await fn(tx);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch((e: Error) => {
          broken = e;
        });
        throw err;
      } finally {
        // A connection whose ROLLBACK failed (timed out, reset) may be mid-protocol: destroy it
        // instead of returning it to the pool.
        client.release(broken);
      }
    },
    async close() {
      await pool.end();
    },
  };
}
