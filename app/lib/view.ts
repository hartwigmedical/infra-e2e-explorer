/**
 * View-scope helper (shared server + client).
 *
 * The server now holds ALL runs, so there's no data "window" any more. But the
 * wide views - the Scenarios matrix and the Services timeline - render one
 * COLUMN per run, so they still bound how many recent runs they show (a UI /
 * payload concern, not a cache one). `?runs=N` widens it; the default is a
 * readable recent slice. The dashboard (a vertical list) and run detail (a
 * single run) don't need this.
 */

export const RUNS_PARAM = "runs";
export const DEFAULT_RECENT_RUNS = 60;
const MAX_RECENT_RUNS = 2000;

/** The recent-run column bound from a request URL's `?runs=` param. */
export function recentRunsFromRequest(request: Request): number {
  const raw = new URL(request.url).searchParams.get(RUNS_PARAM);
  const n = Number(raw);
  return Number.isInteger(n) && n > 0
    ? Math.min(n, MAX_RECENT_RUNS)
    : DEFAULT_RECENT_RUNS;
}
