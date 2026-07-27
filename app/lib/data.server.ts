/**
 * Server-only data access for route loaders (SSR experiment, Phase 3).
 *
 * The `.server.ts` suffix guarantees React Router excludes this (and the native
 * DuckDB / GCS code it pulls in via the store) from the CLIENT bundle - loaders
 * are the only callers. It's the server-side replacement for the client
 * `useE2eQuery` hook: a loader ensures its window is materialized, then runs
 * plain SQL against the store's tables.
 */

import { getStore } from "@/server/data/store";
import { sinceForWindow } from "./window";

/** Materialize the given window's tables (idempotent within a short TTL). */
export async function ensureWindow(windowIndex: number) {
  return getStore().ensureWindow(sinceForWindow(windowIndex));
}

/** Run a SELECT against the materialized tables (runs/scenarios/steps/…). */
export function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return getStore().query<T>(sql);
}

// Touch the store at module load so background warming (see warm.ts) starts as
// early as possible: at server startup in prod (this module is in the RR server
// build's static import graph, evaluated when the server boots), and on the
// first request in dev (Vite loads it lazily). Errors are handled inside the
// warmer; this call only constructs the singleton.
getStore();
