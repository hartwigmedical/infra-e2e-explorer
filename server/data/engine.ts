/**
 * Native DuckDB engine for the server-side data layer (SSR experiment, Phase 1).
 *
 * Replaces the browser's DuckDB-WASM (app/hooks/useDuckDB.ts). The whole app
 * shares ONE in-process instance/connection: DuckDB handles concurrent reads,
 * and the analytical tables (see store.ts) are materialized once per window
 * rather than per request, so a single long-lived connection is what we want.
 *
 * Unlike the WASM path there's no virtual filesystem to register buffers into -
 * native DuckDB reads real files, so slim Parquet lives on disk (see
 * slim-cache.ts) and reports are handed over as local file paths (see
 * sources.ts). No httpfs is loaded: everything read is a local file.
 */

import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";

let instancePromise: Promise<DuckDBInstance> | null = null;
let connPromise: Promise<DuckDBConnection> | null = null;

async function getInstance(): Promise<DuckDBInstance> {
  if (!instancePromise) {
    // In-memory: the durable state is the on-disk slim-Parquet cache, not the
    // DuckDB database itself, so the tables are cheap to rebuild on restart.
    instancePromise = DuckDBInstance.create(":memory:");
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
 * Normalize a DuckDB row into a plain, JSON-serializable object.
 *
 * DuckDB returns BIGINT as JS `BigInt` (not JSON-serializable) and nested
 * STRUCT/LIST values as DuckDB value wrappers. Loaders return their result
 * straight to `JSON.stringify` during SSR, so we recursively coerce BigInt to
 * number (safe for the counts/durations this app deals in) and unwrap arrays.
 */
export function normalizeValue(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(normalizeValue);
  if (v && typeof v === "object") {
    // Plain objects (row objects, unwrapped structs): normalize each field.
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = normalizeValue(val);
    }
    return out;
  }
  return v;
}

/**
 * Run a read query and return normalized, JSON-serializable row objects - the
 * server-side analogue of the client's `query<T>()` (E2eDataContext).
 */
export async function query<T = Record<string, unknown>>(
  sql: string,
): Promise<T[]> {
  const conn = await getConnection();
  const reader = await conn.runAndReadAll(sql);
  return reader.getRowObjects().map((r) => normalizeValue(r)) as T[];
}

/** Run a statement for its side effects (DDL, COPY) - no result rows. */
export async function run(sql: string): Promise<void> {
  const conn = await getConnection();
  await conn.run(sql);
}
