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
 * URL for a run's Cluecumber HTML report (run-level only - see CluecumberLink
 * for why we don't deep-link to a specific feature/scenario page).
 */
export function cluecumberRunUrl(runId: string): string {
  return `http://e2e-test-reports.pilot-1/${encodeURIComponent(runId)}/`;
}
