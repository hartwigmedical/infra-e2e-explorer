/**
 * Shared time/date formatting + link-building helpers for the e2e explorer.
 *
 * Date math here uses UTC accessors throughout (not local time) so that
 * formatting a given instant is stable regardless of the viewer's browser
 * timezone, and so date-only inputs (e.g. "2026-07-09", which JS parses as
 * UTC midnight) round-trip predictably through `absoluteDateTime`.
 */

import { formatDistanceToNow } from "date-fns";

/** Parse a string/Date/null input into a valid Date, or null if unparseable. */
function toValidDate(input: string | Date | null | undefined): Date | null {
  if (input == null) return null;
  const date = input instanceof Date ? input : new Date(input);
  return Number.isNaN(date.getTime()) ? null : date;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "YYYY-MM-DD" for a Date, in UTC. */
function dateOnly(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** "HH:MM:SS" for a Date, in UTC. */
function timeOnly(date: Date): string {
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}

/**
 * The UTC clock window an event occupied, from a start instant (epoch ms) and
 * a duration in seconds — formatted at seconds precision for correlating with
 * logs (GCP Cloud Logging timestamps are UTC too):
 *   "2026-07-17 03:14:05 → 03:14:47 UTC"              (same UTC day — end is time-only)
 *   "2026-07-17 23:59:58 → 2026-07-18 00:00:12 UTC"   (crosses midnight — end repeats the date)
 * With a null/unknown duration only the start is shown ("YYYY-MM-DD HH:MM:SS UTC").
 * Returns "" when the start instant is null or non-finite.
 */
export function utcRunRange(
  startMs: number | null | undefined,
  durationS: number | null | undefined,
): string {
  if (startMs == null || !Number.isFinite(startMs)) return "";
  const start = new Date(startMs);
  const startStr = `${dateOnly(start)} ${timeOnly(start)}`;
  if (durationS == null || !Number.isFinite(durationS)) return `${startStr} UTC`;
  const end = new Date(startMs + durationS * 1000);
  const endStr = dateOnly(end) === dateOnly(start) ? timeOnly(end) : `${dateOnly(end)} ${timeOnly(end)}`;
  return `${startStr} → ${endStr} UTC`;
}

/**
 * The same window as {@link utcRunRange}, but each endpoint as a full ISO 8601
 * instant (millisecond precision, UTC "Z") — for copying into a log query. `end`
 * is null when the duration is null/unknown. Returns null when the start instant
 * is null or non-finite.
 */
export function utcRunRangeIso(
  startMs: number | null | undefined,
  durationS: number | null | undefined,
): { start: string; end: string | null } | null {
  if (startMs == null || !Number.isFinite(startMs)) return null;
  const start = new Date(startMs).toISOString();
  const end =
    durationS != null && Number.isFinite(durationS)
      ? new Date(startMs + durationS * 1000).toISOString()
      : null;
  return { start, end };
}

/**
 * Human-readable time relative to now, e.g. "about 2 hours ago", "2 days ago",
 * "3 months ago". Delegates to date-fns `formatDistanceToNow` (with suffix) so
 * the bucketing is correct — our hand-rolled version mislabelled ~40h-old runs
 * as "yesterday". Returns "" for null/invalid input.
 */
export function relativeTime(input: string | Date | null | undefined): string {
  const date = toValidDate(input);
  if (!date) return "";
  return formatDistanceToNow(date, { addSuffix: true });
}

/**
 * Absolute "YYYY-MM-DD HH:MM" (UTC), or just "YYYY-MM-DD" when the instant
 * has no time-of-day component (i.e. exact UTC midnight, as produced by
 * date-only inputs). Returns "" for null/invalid input.
 */
export function absoluteDateTime(input: string | Date | null | undefined): string {
  const date = toValidDate(input);
  if (!date) return "";

  if (date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0) {
    return dateOnly(date);
  }
  return `${dateOnly(date)} ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}`;
}

/**
 * Path to the scenario history screen, pre-filtered to one scenario. The
 * `feature`/`scenario` query param names are a contract with the scenarios
 * route - do not rename without updating it there.
 */
export function scenarioHistoryPath(featureUri: string, scenarioId: string): string {
  return `/scenarios?feature=${encodeURIComponent(featureUri)}&scenario=${encodeURIComponent(scenarioId)}`;
}

/**
 * Fallback Cluecumber report host, used when the server hasn't supplied a value.
 * The per-deployment value comes from the server's CLUECUMBER_BASE_URL env var —
 * it MUST be runtime, not build-time, because every deployment shares one built
 * client bundle. It reaches the client through the SHELL LOADER (app/layout.tsx),
 * not a `window` global: under SSR there is no `window` while rendering, so
 * reading one here produced markup with this default in every href and then a
 * hydration mismatch wherever the deployment had set something else.
 */
export const DEFAULT_CLUECUMBER_BASE_URL = "http://e2e-test-reports.pilot-1";

/**
 * URL for a run's Cluecumber HTML report (run-level only - see CluecumberLink
 * for why we don't deep-link to a specific feature/scenario page).
 */
export function cluecumberRunUrl(
  runId: string,
  baseUrl: string = DEFAULT_CLUECUMBER_BASE_URL,
): string {
  // Tolerate the env var being set with or without a trailing slash.
  return `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(runId)}/`;
}
