import type { AsyncDuckDBConnection } from "@duckdb/duckdb-wasm";
import { Table, type RecordBatch } from "apache-arrow";

export interface RunQueryOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class QueryTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Query timed out after ${timeoutMs}ms`);
    this.name = "QueryTimeoutError";
  }
}

export class QueryCancelledError extends Error {
  constructor() {
    super("Query cancelled");
    this.name = "QueryCancelledError";
  }
}

/**
 * Run a read query via the pending-query path (`conn.send`) instead of
 * `conn.query`, and return a fully-materialised `arrow.Table` — a drop-in
 * replacement for `conn.query(sql)`.
 *
 * Why this exists: DuckDB-WASM runs everything on a single Web Worker.
 * `conn.query()` maps to a synchronous `RUN_QUERY` that occupies the worker for
 * the query's entire duration, so a long-running SELECT blocks *every* other
 * statement on the shared instance — including the `CREATE OR REPLACE SECRET`
 * auth-token refresh. `conn.send()` maps to `START_PENDING_QUERY` +
 * `POLL_PENDING_QUERY`, which yields the worker between task chunks (~100ms),
 * letting other statements interleave. Measured: a ~10s SELECT blocks a queued
 * statement for the full ~10s via `query()`, versus ~100ms via `send()`.
 *
 * Streaming/backpressure is intentionally not surfaced yet — callers get the
 * same materialised shape they got from `conn.query()`. Use only for statements
 * that produce a single result set (SELECT/DESCRIBE/PRAGMA); DDL, multi-statement
 * SQL, and writes should stay on `conn.query()`.
 */
export async function runQuery(
  conn: AsyncDuckDBConnection,
  sql: string,
  options: RunQueryOptions = {}
): Promise<Table> {
  const execute = async () => {
    const reader = await conn.send(sql);
    const batches: RecordBatch[] = [];
    for await (const batch of reader) {
      batches.push(batch);
    }
    // Pass the schema explicitly so an empty result still carries its columns,
    // matching conn.query()'s behaviour for zero-row results.
    return new Table(reader.schema, batches);
  };

  if (options.signal?.aborted) {
    throw new QueryCancelledError();
  }

  if (!options.timeoutMs && !options.signal) {
    return execute();
  }

  let timedOut = false;
  let cancelled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const query = execute();

  try {
    return await new Promise<Table>((resolve, reject) => {
      if (options.timeoutMs) {
        timeout = setTimeout(() => {
          timedOut = true;
          void conn.cancelSent().catch(() => {});
          reject(new QueryTimeoutError(options.timeoutMs!));
        }, options.timeoutMs);
      }

      onAbort = () => {
        cancelled = true;
        void conn.cancelSent().catch(() => {});
        reject(new QueryCancelledError());
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });

      query.then(resolve, (error) => {
        if (!timedOut && !cancelled) reject(error);
      });
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
  }
}
