import { PGlite } from "@electric-sql/pglite";
import type { Db, Queryable } from "./db.js";

/** In-process Postgres (WASM build) used by the test suite so it needs no running server. */
export async function createPgliteDb(): Promise<Db> {
  const pg = await PGlite.create();
  const wrap = (q: { query: PGlite["query"] }): Queryable => ({
    async query<T>(sql: string, params?: unknown[]) {
      const r = await q.query<T>(sql, params as unknown[]);
      return { rows: r.rows.map(normalizeRow) as T[] };
    },
  });
  const base = wrap(pg);
  return {
    query: base.query,
    async exec(sql: string) {
      await pg.exec(sql);
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return pg.transaction((tx) => fn(wrap(tx)));
    },
    async close() {
      await pg.close();
    },
  };
}

// node-postgres is configured to return int8 as number; make PGlite behave the same.
function normalizeRow<T>(row: T): T {
  if (row === null || typeof row !== "object") return row;
  const out = row as Record<string, unknown>;
  for (const k of Object.keys(out)) if (typeof out[k] === "bigint") out[k] = Number(out[k]);
  return row;
}
