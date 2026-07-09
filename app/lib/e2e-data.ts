import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { runQuery, type RunQueryOptions } from "~/lib/duckdb-query";

/**
 * Run a one-off SELECT against the shared DuckDB instance: opens a
 * connection, runs the query via runQuery (see duckdb-query.ts for why that's
 * preferred over conn.query for long-running statements), converts the Arrow
 * result to plain JS objects, and always closes the connection.
 */
export async function queryE2e<T = any>(
  db: AsyncDuckDB,
  sql: string,
  options?: RunQueryOptions
): Promise<T[]> {
  const conn = await db.connect();
  try {
    const table = await runQuery(conn, sql, options);
    return table.toArray().map((row) => row.toJSON()) as T[];
  } finally {
    await conn.close();
  }
}
