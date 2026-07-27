/**
 * Rolling-window presets, shared by the server loaders and the client shell.
 *
 * The selected window lives in the URL (`?w=<index>`) so it's the single source
 * of truth for every SSR loader (which read it from the request) AND the client
 * shell (which reads it from the router). This replaces the client-only,
 * localStorage-backed window state the SPA kept in E2eDataContext.
 */

import { format, subDays } from "date-fns";

export interface WindowStep {
  label: string;
  /** Days back from today; null = "all time". */
  days: number | null;
}

/** Widest last; the default is the past week (fast to load). */
export const WINDOW_STEPS: WindowStep[] = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 3 months", days: 90 },
  { label: "Last year", days: 365 },
  { label: "All time", days: null },
];

export const DEFAULT_WINDOW_INDEX = 0;

/** URL search param holding the window preset index. */
export const WINDOW_PARAM = "w";

/** A valid preset index, falling back to the default for absent/invalid input. */
export function clampWindowIndex(value: unknown): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n < WINDOW_STEPS.length
    ? n
    : DEFAULT_WINDOW_INDEX;
}

/** The `since` cutoff (YYYY-MM-DD) for a preset. "All time" uses a far-past date
 *  so the store's `since` path still returns everything. */
export function sinceForWindow(windowIndex: number): string {
  const days = WINDOW_STEPS[clampWindowIndex(windowIndex)]?.days ?? null;
  if (days == null) return "2000-01-01";
  return format(subDays(new Date(), days), "yyyy-MM-dd");
}

/** The window index encoded in a request URL's `?w=` param. */
export function windowIndexFromRequest(request: Request): number {
  const url = new URL(request.url);
  return clampWindowIndex(url.searchParams.get(WINDOW_PARAM) ?? DEFAULT_WINDOW_INDEX);
}

export function windowLabel(windowIndex: number): string {
  return WINDOW_STEPS[clampWindowIndex(windowIndex)].label;
}

/** Label of the next wider preset, or null once at "All time". */
export function nextWindowLabel(windowIndex: number): string | null {
  const i = clampWindowIndex(windowIndex);
  return i < WINDOW_STEPS.length - 1 ? WINDOW_STEPS[i + 1].label : null;
}
