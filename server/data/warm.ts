/**
 * Cache pre-warming.
 *
 * Moving report parse cost server-side puts it in the request path: a COLD
 * dataset (nothing extracted yet) makes the first loader wait on fetch+parse.
 * Warming keeps the slim-Parquet cache + materialized tables hot, so loaders hit
 * the warm path (~200 ms) instead of the cold one.
 *
 * IMPORTANT: this must run in the SAME module graph as the loaders so it shares
 * the store singleton - hence it's kicked off from getStore() (see store.ts),
 * not from the Express entry (which, in both dev via Vite's SSR module runner
 * and prod via the separate esbuild shim, is a DIFFERENT module graph with its
 * own singleton). It fires as soon as the store is first created - at prod
 * startup (the RR server build evaluates data.server at import time) and on the
 * first request in dev.
 *
 * Not yet done: a durable GCS `cache/` mirror so a fresh Cloud Run instance
 * starts warm instead of re-extracting from the bucket.
 */

import type { E2eStore } from "./store.ts";

/** Re-warm interval - short enough to pick up new runs. 0 disables it. */
const WARM_INTERVAL_MS = Number(process.env.E2E_WARM_INTERVAL_MS ?? 5 * 60_000);
/** Set E2E_WARM=0 to disable warming entirely (e.g. in measurement scripts). */
const WARM_ENABLED = process.env.E2E_WARM !== "0";

let started = false;

/** Materialize the full dataset (isolated + logged; `force` bypasses the TTL).
 *  Uses the WAITING variant: doing the extraction here, off the request path, is
 *  the entire point of warming - loaders only ever materialize what's cached. */
async function warmOnce(store: E2eStore): Promise<void> {
  try {
    const t0 = Date.now();
    const state = await store.ensureComplete(true);
    console.log(
      `[warm] ${state.cachedRunCount}/${state.runCount} runs ready in ${Date.now() - t0}ms` +
        (state.pendingRunCount > 0
          ? ` (${state.pendingRunCount} not extracted)`
          : ""),
    );
  } catch (err) {
    console.warn(`[warm] failed:`, (err as Error)?.message ?? err);
  }
}

/** Start background warming for this store (idempotent per process). */
export function startWarming(store: E2eStore): void {
  if (started || !WARM_ENABLED) return;
  started = true;

  void warmOnce(store);

  if (WARM_INTERVAL_MS > 0) {
    const timer = setInterval(() => void warmOnce(store), WARM_INTERVAL_MS);
    // Don't hold the event loop open just for warming.
    if (typeof timer.unref === "function") timer.unref();
  }
}
