/**
 * Server-only data access for route loaders.
 *
 * The `.server.ts` suffix guarantees React Router excludes this (and the native
 * DuckDB / GCS code it pulls in via the store) from the CLIENT bundle - loaders
 * are the only callers. It's the server-side replacement for the client
 * `useE2eQuery` hook: a loader ensures the dataset is materialized, then runs
 * plain SQL against the store's tables/views.
 */

import { getStore } from "@/server/data/store";

/** Ensure the windowed dataset is materialized (idempotent within a short TTL). */
export async function ensureData() {
  return getStore().ensure();
}

/**
 * Load a run that's OUTSIDE the store's window, extracting it if needed, so a
 * deep link to an older run still works. Returns null when no such run exists.
 * Callers query the returned `features` relation instead of the materialized
 * tables - see E2eStore.outOfWindowRun and app/routes/runs.$runId.tsx.
 */
export async function loadOutOfWindowRun(runId: string) {
  return getStore().outOfWindowRun(runId);
}

/** A relation over one run's own cached Parquet (null if not extracted yet).
 *  Single-run reads use this instead of the whole-window views - see
 *  E2eStore.runRelation. */
export function runRelation(runId: string) {
  return getStore().runRelation(runId);
}

/** Run a SELECT against the materialized tables (runs/scenarios/…) or views
 *  (v_steps). */
export function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return getStore().query<T>(sql);
}

// Touch the store at module load so background warming (see warm.ts) starts as
// early as possible: at server startup in prod (this module is in the RR server
// build's static import graph, evaluated when the server boots), and on the
// first request in dev (Vite loads it lazily).
getStore();
