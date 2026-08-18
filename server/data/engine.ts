/**
 * Native DuckDB engine for the server-side data layer.
 *
 * The whole app shares ONE in-process instance/connection: DuckDB handles
 * concurrent reads, and the analytical tables (see store.ts) are materialized
 * once for the whole dataset rather than per request, so a single long-lived
 * connection is what we want.
 *
 * Everything DuckDB reads is a real local file: the extracted per-run Parquet
 * lives on disk (see cache.ts) and raw reports are handed over as local file
 * paths (see sources.ts). No httpfs is loaded.
 */

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import os from "node:os";
import path from "node:path";

let instancePromise: Promise<DuckDBInstance> | null = null;
let connPromise: Promise<DuckDBConnection> | null = null;

/**
 * Where DuckDB spills when a query exceeds its memory budget.
 *
 * MUST be set explicitly: `temp_directory` defaults to the process CWD, which is
 * the repo root in dev (spill files reached tens of GB there once) and /app in
 * the container - root-owned, so `USER node` can't even write it, and on Cloud
 * Run it would eat the instance's ephemeral disk. Local temp is the right place:
 * never the gcsfuse cache mount (spilling over the network would be pathological)
 * and cleared by the OS between boots.
 */
const TEMP_DIRECTORY =
  process.env.E2E_DUCKDB_TEMP_DIR ||
  path.join(os.tmpdir(), "e2e-explorer-duckdb");

/** Optional hard cap on DuckDB's memory (e.g. "2GB"). Unset = DuckDB's own
 *  default (a share of physical RAM); worth setting to fit the container's memory
 *  limit, since exceeding it spills to TEMP_DIRECTORY instead of being killed. */
const MEMORY_LIMIT = process.env.E2E_DUCKDB_MEMORY_LIMIT;

async function getInstance(): Promise<DuckDBInstance> {
  if (!instancePromise) {
    // In-memory: the durable state is the on-disk slim-Parquet cache, not the
    // DuckDB database itself, so the tables are cheap to rebuild on restart.
    instancePromise = DuckDBInstance.create(":memory:", {
      temp_directory: TEMP_DIRECTORY,
      ...(MEMORY_LIMIT ? { memory_limit: MEMORY_LIMIT } : {}),
    });
  }
  return instancePromise;
}

/** The shared connection. Lazily created on first use, reused thereafter. Used
 *  for materialization + queries, which run sequentially on one connection. */
export async function getConnection(): Promise<DuckDBConnection> {
  if (!connPromise) {
    connPromise = getInstance().then((inst) => inst.connect());
  }
  return connPromise;
}

/**
 * Run `fn` with a DEDICATED connection to the shared instance, closed
 * afterwards. Concurrent slim extractions each COPY on their own connection -
 * a single connection processes statements one at a time, so parallel COPYs
 * must not share one. All connections see the same catalog/database, so tables
 * materialized on the shared connection still see files written here.
 */
export async function withConnection<T>(
  fn: (conn: DuckDBConnection) => Promise<T>,
): Promise<T> {
  const inst = await getInstance();
  const conn = await inst.connect();
  try {
    return await fn(conn);
  } finally {
    conn.closeSync();
  }
}

/**
 * Normalize a JS-converted DuckDB row into a plain, JSON-serializable object.
 *
 * Reading rows goes through `getRowObjectsJS()`, NOT `getRowObjects()`: the
 * latter hands back DuckDB value wrappers, so a LIST column (e.g.
 * `scenarios.tag_names`) arrives as `{ items: [...] }` rather than an array and
 * every `Array.from(...)` on it silently yields nothing. The JS conversion
 * unwraps LIST/ARRAY to arrays, STRUCT to objects, and TIMESTAMP/DATE to `Date`.
 *
 * What's left after that is BIGINT (JS `BigInt`, not JSON-serializable) and
 * `Date`. Loaders return their result straight to serialization during SSR, so
 * we recursively coerce BigInt to number (safe for the counts/durations this app
 * deals in) and Date to an ISO string.
 */
export function normalizeValue(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(normalizeValue);
  // Binary (BLOB/BIT) stays as-is; recursing would turn it into {"0":…}.
  if (v instanceof Uint8Array) return v;
  if (v && typeof v === "object") {
    // Plain objects (row objects, converted structs): normalize each field.
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = normalizeValue(val);
    }
    return out;
  }
  return v;
}

/**
 * Run a read query and return normalized, JSON-serializable row objects (what
 * route loaders hand straight to JSON.stringify during SSR).
 */
export async function query<T = Record<string, unknown>>(
  sql: string,
): Promise<T[]> {
  const conn = await getConnection();
  const reader = await conn.runAndReadAll(sql);
  return reader.getRowObjectsJS().map((r) => normalizeValue(r)) as T[];
}

/** Run a statement for its side effects (DDL, COPY) - no result rows. */
export async function run(sql: string): Promise<void> {
  const conn = await getConnection();
  await conn.run(sql);
}
