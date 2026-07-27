import { useState } from "react";
import { Link, useLoaderData } from "react-router";
import { EyeOff, X } from "lucide-react";
import type { Route } from "./+types/index";
import { useRunScope } from "~/contexts/RunScopeContext";
import { ensureWindow, query } from "~/lib/data.server";
import { windowIndexFromRequest } from "~/lib/window";
import StatusBadge from "~/components/StatusBadge";
import Sparkline from "~/components/Sparkline";
import CluecumberLink from "~/components/CluecumberLink";
import { statusKindFromRunToken } from "~/lib/status";
import { relativeTime, absoluteDateTime } from "~/lib/format";
import { cn } from "~/lib/utils";

interface RunRow {
  run_id: string;
  run_time: string | null;
  updated: string | null;
  status_token: string;
  failed_count: number | null;
  total_count: number | null;
  is_nightly: boolean;
}

interface ScenarioCountRow {
  run_id: string;
  passed: number;
  failed: number;
  skipped: number;
}

const RUNS_SQL = `
  SELECT run_id, run_time, updated, status_token, failed_count, total_count, is_nightly
  FROM runs
  ORDER BY run_id DESC
`;

const SCENARIO_COUNTS_SQL = `
  SELECT run_id,
    count(*) FILTER (WHERE status = 'passed') AS passed,
    count(*) FILTER (WHERE status = 'failed') AS failed,
    count(*) FILTER (WHERE status = 'skipped') AS skipped
  FROM scenarios
  GROUP BY run_id
`;

/** Load the window's runs + per-run scenario counts server-side, so the table
 *  and trend arrive as real HTML (no client DuckDB, no waterfall). */
export async function loader({ request }: Route.LoaderArgs) {
  await ensureWindow(windowIndexFromRequest(request));
  const [runs, counts] = await Promise.all([
    query<RunRow>(RUNS_SQL),
    query<ScenarioCountRow>(SCENARIO_COUNTS_SQL),
  ]);
  return { runs, counts };
}

// run_id is always "YYYY-MM-DD-HHMM-<suffix>" - the date is more robust to
// pull from the id itself than from the run_date TIMESTAMP column (which
// round-trips through Arrow with type quirks we don't need to deal with here).
function formatRunDate(runId: string): string {
  return runId.slice(0, 10);
}

function formatRunTime(runTime: string | null | undefined): string {
  if (!runTime || runTime.length !== 4) return "—";
  return `${runTime.slice(0, 2)}:${runTime.slice(2, 4)}`;
}

// Fallback instant (UTC ISO string) built from the run_id's embedded date and
// the run_time column, used when `updated` is null so relativeTime/
// absoluteDateTime still have something to work with.
function fallbackInstant(
  runId: string,
  runTime: string | null | undefined,
): string | null {
  const datePart = runId.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return null;
  const timePart =
    runTime && runTime.length === 4
      ? `${runTime.slice(0, 2)}:${runTime.slice(2, 4)}`
      : "00:00";
  return `${datePart}T${timePart}:00Z`;
}

function TypeBadge({ isNightly }: { isNightly: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        isNightly
          ? "bg-sky-500/15 text-sky-600 dark:text-sky-400"
          : "bg-zinc-500/10 text-muted-foreground",
      )}
    >
      {isNightly ? "Nightly" : "Manual"}
    </span>
  );
}

// One scenario-count value. A non-zero count links to the Scenarios matrix
// pre-filtered to that run × status (e.g. the failed count opens
// /scenarios?frun=<run>&fstatus=failed - a one-click path to that view). A zero
// count isn't linked (it would open an empty filtered view) and is dimmed to
// read as non-interactive, matching the Scenarios page's own 0-count handling.
function CountLink({
  runId,
  status,
  count,
  colorClass,
}: {
  runId: string;
  status: "passed" | "failed" | "skipped";
  count: number;
  colorClass: string;
}) {
  if (count === 0) {
    return <span className={cn(colorClass, "opacity-40")}>{count}</span>;
  }
  return (
    <Link
      to={`/scenarios?frun=${encodeURIComponent(runId)}&fstatus=${status}`}
      title={`View ${status} scenarios in this run`}
      className={cn(
        colorClass,
        "relative rounded-sm hover:underline focus-visible:underline focus-visible:outline-none",
        // Enlarge the tap target (a single digit is a tiny hit area) WITHOUT
        // shifting layout: a transparent, out-of-flow ::before that extends the
        // clickable region past the digit on all sides. It's part of the link,
        // so taps on it still navigate.
        "before:absolute before:-inset-x-2.5 before:-inset-y-2 before:content-['']",
      )}
    >
      {count}
    </Link>
  );
}

function ScenarioCounts({
  counts,
  runId,
}: {
  counts: ScenarioCountRow | undefined;
  runId: string;
}) {
  if (!counts) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs">
      <CountLink
        runId={runId}
        status="passed"
        count={counts.passed}
        colorClass="text-emerald-600 dark:text-emerald-400"
      />
      <span className="text-muted-foreground">/</span>
      <CountLink
        runId={runId}
        status="failed"
        count={counts.failed}
        colorClass="text-red-600 dark:text-red-400"
      />
      <span className="text-muted-foreground">/</span>
      <CountLink
        runId={runId}
        status="skipped"
        count={counts.skipped}
        colorClass="text-amber-600 dark:text-amber-400"
      />
    </span>
  );
}

export default function Index() {
  const { runs, counts } = useLoaderData<typeof loader>();
  const { nightlyOnly, setNightlyOnly } = useRunScope();

  const countsByRun = new Map(counts.map((r) => [r.run_id, r]));

  // The nightly/all-runs filter (global, from the date-range control) governs
  // which runs the table, count, and trend reflect. When nightly-only, every
  // shown run is a nightly, so the Type column is redundant and hidden.
  const displayRuns = nightlyOnly ? runs.filter((r) => r.is_nightly) : runs;
  const showType = !nightlyOnly;

  // In nightly mode, warn when there are manual runs newer than the newest
  // nightly (so the actual latest run is hidden). `runs` is newest-first, so
  // the leading non-nightly runs are exactly those newer ones. Dismissal is
  // in-memory only — a refresh brings the notice back.
  const [hiddenNoticeDismissed, setHiddenNoticeDismissed] = useState(false);
  let hiddenNewerCount = 0;
  for (const r of runs) {
    if (r.is_nightly) break;
    hiddenNewerCount++;
  }
  const showHiddenNotice = nightlyOnly && hiddenNewerCount > 0 && !hiddenNoticeDismissed;
  const showAllRuns = () => setNightlyOnly(false);

  // Pass rate per shown run, oldest -> newest, for the header sparkline.
  const passRates = displayRuns
    .slice()
    .sort((a, b) => (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0))
    .map((r) => {
      const c = countsByRun.get(r.run_id);
      if (!c) return null;
      const total = c.passed + c.failed + c.skipped;
      return total > 0 ? c.passed / total : null;
    })
    .filter((v): v is number => v !== null);

  const latestPassRate =
    passRates.length > 0 ? passRates[passRates.length - 1] : null;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">Recent Runs</h1>
          <p className="text-sm text-muted-foreground">
            {displayRuns.length} run{displayRuns.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-2">
          <span className="text-xs text-muted-foreground">Pass rate</span>
          {passRates.length >= 2 ? (
            <>
              <Sparkline
                values={passRates.map((v) => v * 100)}
                className="text-emerald-500"
              />
              <span className="text-sm font-medium tabular-nums">
                {latestPassRate !== null
                  ? `${Math.round(latestPassRate * 100)}%`
                  : "—"}
              </span>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">
              Not enough data
            </span>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-muted/50">
            <tr className="text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">Run</th>
              {showType && <th className="px-3 py-2 font-medium">Type</th>}
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Scenarios</th>
              <th className="px-3 py-2 font-medium">Report</th>
            </tr>
          </thead>
          <tbody>
            {showHiddenNotice && (
              <tr>
                <td
                  colSpan={showType ? 5 : 4}
                  className="border-b border-sky-500/20 bg-sky-500/5 px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={showAllRuns}
                      className="inline-flex items-center gap-2 text-left text-xs text-sky-700 hover:underline dark:text-sky-400"
                    >
                      <EyeOff size={13} className="shrink-0" />
                      <span>
                        {hiddenNewerCount === 1
                          ? "A more recent run is hidden by the Nightly filter"
                          : `${hiddenNewerCount} more recent runs are hidden by the Nightly filter`}
                        {" — "}
                        <span className="font-medium">show all runs</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setHiddenNoticeDismissed(true)}
                      title="Dismiss"
                      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            )}
            {displayRuns.length === 0 && (
              <tr>
                <td
                  colSpan={showType ? 5 : 4}
                  className="px-3 py-6 text-center text-muted-foreground"
                >
                  No runs found.
                </td>
              </tr>
            )}
            {displayRuns.map((run) => {
              const instant =
                run.updated ?? fallbackInstant(run.run_id, run.run_time);
              const primary =
                relativeTime(instant) || formatRunDate(run.run_id);
              const absolute =
                absoluteDateTime(instant) ||
                `${formatRunDate(run.run_id)} ${formatRunTime(run.run_time)}`;
              return (
                <tr key={run.run_id} className="group border-t">
                  <td className="p-0">
                    <Link
                      to={`/runs/${encodeURIComponent(run.run_id)}`}
                      title={run.run_id}
                      className="block px-3 py-2 group-hover:bg-muted/40"
                    >
                      <div className="font-medium">{primary}</div>
                      <div className="text-xs text-muted-foreground">
                        {absolute}
                      </div>
                    </Link>
                  </td>
                  {showType && (
                    <td className="p-0">
                      <Link
                        to={`/runs/${encodeURIComponent(run.run_id)}`}
                        className="block px-3 py-2 group-hover:bg-muted/40"
                      >
                        <TypeBadge isNightly={run.is_nightly} />
                      </Link>
                    </td>
                  )}
                  <td className="p-0">
                    <Link
                      to={`/runs/${encodeURIComponent(run.run_id)}`}
                      className="block px-3 py-2 group-hover:bg-muted/40"
                    >
                      <StatusBadge
                        kind={statusKindFromRunToken(run.status_token)}
                      />
                    </Link>
                  </td>
                  {/* Not a run-detail link: each count drills into the
                      Scenarios view for this run × status (run detail is still
                      reachable via the Run/Type/Status cells). */}
                  <td className="px-3 py-2 group-hover:bg-muted/40">
                    <ScenarioCounts
                      counts={countsByRun.get(run.run_id)}
                      runId={run.run_id}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <CluecumberLink runId={run.run_id} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
