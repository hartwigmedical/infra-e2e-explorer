/**
 * Cache pre-warming (SSR experiment, Phase 4).
 *
 * Moving report parse cost server-side puts it in the request path: a COLD
 * window (nothing extracted yet) makes the first loader wait on fetch+parse.
 * Warming keeps the slim-Parquet cache (and the materialized tables) hot for the
 * common windows, so loaders hit the warm path (~200 ms) instead of the cold one.
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
 * starts warm instead of re-extracting from the bucket (Phase 4 follow-up).
 */

import type { E2eStore } from "./store.ts";
import { sinceForWindow } from "../../app/lib/window.ts";

/** Window preset indices to keep warm (default: the landing 7-day window). */
const WARM_WINDOWS = (process.env.E2E_WARM_WINDOWS ?? "0")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n >= 0);

/** Re-warm interval - short enough to pick up new runs (the store's own window
 *  TTL is 60 s, so anything past that re-materializes). 0 disables re-warming. */
const WARM_INTERVAL_MS = Number(process.env.E2E_WARM_INTERVAL_MS ?? 5 * 60_000);

let started = false;

/** Warm the configured windows once (each failure is isolated + logged). */
async function warmOnce(store: E2eStore): Promise<void> {
  for (const idx of WARM_WINDOWS) {
    try {
      const t0 = Date.now();
      const state = await store.ensureWindow(sinceForWindow(idx));
      console.log(
        `[warm] window ${idx}: ${state.runCount} runs ready in ${Date.now() - t0}ms`,
      );
    } catch (err) {
      console.warn(
        `[warm] window ${idx} failed:`,
        (err as Error)?.message ?? err,
      );
    }
  }
}

/** Start background warming for this store (idempotent per process). */
export function startWarming(store: E2eStore): void {
  if (started || WARM_WINDOWS.length === 0) return;
  started = true;

  void warmOnce(store);

  if (WARM_INTERVAL_MS > 0) {
    const timer = setInterval(() => void warmOnce(store), WARM_INTERVAL_MS);
    // Don't hold the event loop open just for warming.
    if (typeof timer.unref === "function") timer.unref();
  }
}
