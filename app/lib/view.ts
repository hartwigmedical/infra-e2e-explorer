/**
 * View-scope helper (shared server + client).
 *
 * Separate from the store's data window (E2E_WINDOW_DAYS): the wide views - the
 * Scenarios matrix and the Services timeline - render one COLUMN per run, so they
 * bound how many recent runs they SHOW (a UI / payload concern). `?runs=N` widens
 * it; the default is a readable recent slice. The dashboard (a vertical list) and
 * run detail (a single run) don't need this.
 */

export const RUNS_PARAM = "runs";
export const DEFAULT_RECENT_RUNS = 60;
/** Hard cap on `?runs=`, so one URL can't ask for an unbounded payload. */
export const MAX_RECENT_RUNS = 2000;

/**
 * How many runs a "show all" affordance can actually deliver. `?runs=` is
 * clamped, so a link offering more than the cap could never be satisfied - the
 * footer would keep saying "showing 2000 of N" after the click.
 */
export function showAllRunCount(totalRuns: number): number {
  return Math.min(totalRuns, MAX_RECENT_RUNS);
}

/** The recent-run column bound from a request URL's `?runs=` param. */
export function recentRunsFromRequest(request: Request): number {
  const raw = new URL(request.url).searchParams.get(RUNS_PARAM);
  const n = Number(raw);
  return Number.isInteger(n) && n > 0
    ? Math.min(n, MAX_RECENT_RUNS)
    : DEFAULT_RECENT_RUNS;
}
