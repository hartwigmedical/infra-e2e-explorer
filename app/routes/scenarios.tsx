import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link,
  useLoaderData,
  useSearchParams,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import {
  ArrowRight,
  ChevronRight,
  Clock,
  Search,
  Triangle,
  X,
} from "lucide-react";
import type { Route } from "./+types/scenarios";
import { useRunScope } from "~/contexts/RunScopeContext";
import { ensureData, query } from "~/lib/data.server";
import { recentRunsFromRequest, RUNS_PARAM, showAllRunCount } from "~/lib/view";
import StatusMark from "~/components/StatusMark";
import TagFilter from "~/components/TagFilter";
import {
  statusClasses,
  statusDotClass,
  statusKindFromScenario,
  statusLabel,
  type StatusKind,
} from "~/lib/status";
import {
  buildSpecByService,
  computeRunDeployFlags,
  makeIsSuspectDeploy,
  type RunDeployFlags,
} from "~/lib/deployments";
import { cn } from "~/lib/utils";
import { useUrlBackedTextFilter } from "~/hooks/useUrlBackedTextFilter";

/** Which metric the matrix body shows: run pass/fail status, run duration, or
 *  "stability" — annotating each scenario's status changes as flaky or not. */
type Metric = "status" | "duration" | "stability";

/** One run's status change for a scenario, classified for the stability view.
 *  A pass→fail is "flaky" with no suspect deploy that run; a fail→pass is
 *  "flaky" with no deploy at all (see the Scenarios stability notes). */
type StabilityKind =
  | "none" // no change vs the scenario's previous run (or first appearance)
  | "flaky-regress" // pass → fail, unexplained by a suspect deploy
  | "explained-regress" // pass → fail, on a run with a suspect deploy
  | "flaky-recover" // fail → pass, unexplained by any deploy
  | "explained-recover" // fail → pass, on a run with a deploy
  | "other-change"; // any other transition (skipped ↔ …)

/** Classify a scenario's status at one run vs its previous run. `flags` is the
 *  run-level deploy summary for that run. */
function classifyStability(
  prev: string | null | undefined,
  cur: string | null | undefined,
  flags: RunDeployFlags | undefined,
): StabilityKind {
  if (prev == null || cur == null || prev === cur) return "none";
  if (prev === "passed" && cur === "failed")
    return flags?.hasSuspectDeploy ? "explained-regress" : "flaky-regress";
  if (prev === "failed" && cur === "passed")
    return flags?.hasDeploy ? "explained-recover" : "flaky-recover";
  return "other-change";
}

const FLAKY_KINDS: ReadonlySet<StabilityKind> = new Set([
  "flaky-regress",
  "flaky-recover",
]);
/** Transitions that count toward the flakiness ratio (pass↔fail flips). */
const FLIP_KINDS: ReadonlySet<StabilityKind> = new Set([
  "flaky-regress",
  "explained-regress",
  "flaky-recover",
  "explained-recover",
]);

/** A run of consecutive same-status runs for one scenario or step (a bar in the
 *  stability timeline). `flip` classifies the transition INTO this run vs the
 *  previous appearance ("none" for the first one). */
interface StatusSegment {
  startIdx: number;
  runCount: number;
  statusKind: StatusKind;
  flip: StabilityKind;
  startRunId: string;
  endRunId: string;
}

/** Collapse a per-run status sequence (a scenario's, or a single step's) into
 *  status-interval segments, tagging each segment's leading transition (flip)
 *  and tallying flaky/total flips. An absent run breaks a segment (gap); the
 *  flip compares to the previous segment's status (the previous appearance). */
function buildStatusSegments<C extends { status: string }>(
  cells: Map<string, C>,
  runIds: string[],
  runFlags: Map<string, RunDeployFlags>,
): { segments: StatusSegment[]; flaky: number; flips: number } {
  const segments: StatusSegment[] = [];
  let flaky = 0;
  let flips = 0;
  let prevStatus: string | null = null;
  let i = 0;
  while (i < runIds.length) {
    const cell = cells.get(runIds[i]);
    if (!cell) {
      i++;
      continue;
    }
    const status = cell.status;
    let j = i + 1;
    while (j < runIds.length && cells.get(runIds[j])?.status === status) j++;
    const flip = classifyStability(prevStatus, status, runFlags.get(runIds[i]));
    if (FLIP_KINDS.has(flip)) flips++;
    if (FLAKY_KINDS.has(flip)) flaky++;
    segments.push({
      startIdx: i,
      runCount: j - i,
      statusKind: statusKindFromScenario(status),
      flip,
      startRunId: runIds[i],
      endRunId: runIds[j - 1],
    });
    prevStatus = status;
    i = j;
  }
  return { segments, flaky, flips };
}

function stabilityTip(kind: StabilityKind): string {
  switch (kind) {
    case "flaky-regress":
      return "pass → fail · flaky (no suspect deploy this run)";
    case "flaky-recover":
      return "fail → pass · flaky (no deploy this run)";
    case "explained-regress":
      return "pass → fail · after a suspect deploy";
    case "explained-recover":
      return "fail → pass · after a deploy";
    case "other-change":
      return "status changed";
    default:
      return "no change";
  }
}

/** The stability timeline for one row (a scenario, or a single step): status-
 *  interval bars laid across `runCount` columns, each coloured by its status; a
 *  ▲ marks a flaky flip and links to the run where it happened. `label` heads
 *  each bar's tooltip; `linkFor(runId)` builds the flaky-flip link target. */
function StabilityBars({
  segments,
  runCount,
  label,
  linkFor,
}: {
  segments: StatusSegment[];
  runCount: number;
  label: string;
  linkFor: (runId: string) => string;
}) {
  return (
    <div className="relative my-1.5 h-4">
      {segments.map((seg) => {
        const flaky = FLAKY_KINDS.has(seg.flip);
        const span =
          seg.runCount === 1
            ? seg.startRunId.slice(5, 10)
            : `${seg.startRunId.slice(5, 10)} → ${seg.endRunId.slice(5, 10)}`;
        return (
          <div
            key={seg.startIdx}
            title={`${label}\n${statusLabel(seg.statusKind)} · ${span}${seg.flip !== "none" ? `\n${stabilityTip(seg.flip)}` : ""}`}
            className={cn(
              "absolute top-0 bottom-0 rounded-sm",
              statusDotClass(seg.statusKind),
            )}
            style={{
              left: `calc(${(seg.startIdx / runCount) * 100}% + 1.5px)`,
              width: `calc(${(seg.runCount / runCount) * 100}% - 3px)`,
            }}
          >
            {flaky && (
              // Only the flaky marker is interactive: it links to the run where
              // the flip happened.
              <Link
                to={linkFor(seg.startRunId)}
                title={`${stabilityTip(seg.flip)}\nopen ${seg.startRunId.slice(5, 10)}`}
                className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${(0.5 / seg.runCount) * 100}%` }}
              >
                <Triangle
                  size={11}
                  className="fill-white text-white transition-transform hover:scale-125"
                />
              </Link>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Per-run tally of scenario outcomes, for the column-header popover. */
interface RunStat {
  passed: number;
  failed: number;
  skipped: number;
}

interface HistoryRow {
  run_id: string;
  status: string;
  duration_s: number | null;
  is_nightly: boolean;
}

interface StepHistoryRow {
  run_id: string;
  step_ordinal: number;
  step_label: string;
  status: string;
  duration_s: number | null;
  has_error: boolean;
  error_message: string | null;
  /** True for steps folded in from the feature's Background (see v_scenarios). */
  is_background: boolean;
  is_nightly: boolean;
}

interface SelectedScenario {
  feature_uri: string;
  feature_name: string;
  scenario_id: string;
  scenario_name: string;
}

/**
 * Identity + display info for whichever scenario the URL points at. Resolved
 * directly from the `scenarios` table by exact (feature_uri, scenario_id)
 * match - independent of the matrix's nightly/search/tag filters, so a deep
 * link stays resolvable even when those filters would hide the row.
 */
interface ScenarioIdentityRow {
  feature_uri: string;
  feature_name: string;
  scenario_id: string;
  scenario_name: string;
  tag_names: string[] | null;
}

/** One (scenario, run) cell of the matrix, straight from the join. `is_nightly`
 *  lets the nightly/all-runs scope be applied client-side (see the loader). */
interface MatrixCellRow {
  feature_uri: string;
  feature_name: string;
  scenario_id: string;
  scenario_name: string;
  tag_names: string[] | null;
  run_id: string;
  status: string;
  duration_s: number | null;
  is_nightly: boolean;
}

/** (run, service, spec) row feeding the stability view's per-run deploy flags. */
interface VersionScopeRow {
  run_id: string;
  service: string;
  spec: string | null;
}

interface MatrixCell {
  status: string;
  duration_s: number | null;
}

/** One matrix row: a scenario, its per-run cells, and its summary stats. */
interface MatrixScenario {
  feature_uri: string;
  feature_name: string;
  scenario_id: string;
  scenario_name: string;
  tag_names: string[];
  cells: Map<string, MatrixCell>;
  /** Status in the most recent run this scenario appeared in (for the row dot + "failed last run" filter). */
  latestStatus: string;
  passed: number;
  total: number;
  passRate: number;
  /** Mean duration over PASSED runs only (failed/skipped durations are truncated). */
  durAvg: number | null;
  /** Coefficient of variation (SD/mean) over passed runs, or null with < 2 samples. */
  durCv: number | null;
  durCount: number;
}

interface MatrixGroup {
  feature_name: string;
  scenarios: MatrixScenario[];
}

/** Escape a value for safe interpolation into a single-quoted SQL string literal. */
function sqlLit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Decode a URL search-param value, tolerating malformed percent-escapes. */
function safeDecodeURIComponent(value: string | null): string | null {
  if (value == null) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Normalise a DuckDB LIST column value into a plain JS string array. Arrow
 * returns these as vector-like objects (iterable, but without .map/.slice/
 * .some), so every call site that touches tag_names must go through this
 * rather than assuming a real Array.
 */
function toTagArray(value: unknown): string[] {
  if (!value) return [];
  return Array.from(value as Iterable<string>);
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation; null with fewer than two points. */
function sampleStdDev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs);
  const variance =
    xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/** Linear-interpolated q-quantile (0..1) of an ascending-sorted array. */
function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sortedAsc.length - 1);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

/** Compact duration for axis/caption labels: "20s" / "45m" / "2h" / "1h30m". */
function formatDurShort(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m ? `${h}h${m}m` : `${h}h`;
}

/** The matrix renders one COLUMN per run, so it's bounded to the most recent N
 *  runs (a UI/payload bound - the server holds all runs). The nightly/all-runs
 *  scope is then applied CLIENT-SIDE over those (like search/tag/failed
 *  filters), so each cell carries `is_nightly`. */
const recentCte = (n: number) =>
  `SELECT run_id FROM runs ORDER BY run_id DESC LIMIT ${n}`;

const matrixSql = (n: number) => `
    SELECT s.feature_uri, s.feature_name, s.scenario_id, s.scenario_name, s.tag_names,
           s.run_id, s.status, s.duration_s, r.is_nightly
    FROM scenarios s
    JOIN runs r USING (run_id)
    WHERE s.run_id IN (${recentCte(n)})
    ORDER BY s.feature_name, s.scenario_name, s.run_id
  `;

/** (run, service, spec) over the same recent-N runs — feeds the run-level
 *  deploy flags the stability view uses to tell flaky changes from deploys. */
const serviceVersionsScopeSql = (n: number) => `
    SELECT sv.run_id, sv.service, sv.spec
    FROM service_versions sv
    WHERE sv.run_id IN (${recentCte(n)})
  `;

// Scenario detail history spans every run the scenario appears in (a single
// scrollable row), so it's not column-bounded.
function buildHistorySql(featureUri: string, scenarioId: string): string {
  return `
    SELECT s.run_id, s.status, s.duration_s, r.is_nightly
    FROM scenarios s
    JOIN runs r USING (run_id)
    WHERE s.feature_uri = ${sqlLit(featureUri)} AND s.scenario_id = ${sqlLit(scenarioId)}
    ORDER BY s.run_id
  `;
}

// Steps come from the v_steps VIEW (read from the cached Parquet on demand), not a
// materialized table - see server/data/store.ts.
function buildStepHistorySql(featureUri: string, scenarioId: string): string {
  return `
    SELECT st.run_id, st.step_ordinal, st.step_label, st.status, st.duration_s, st.has_error, st.error_message, st.is_background, r.is_nightly
    FROM v_steps st
    JOIN runs r USING (run_id)
    WHERE st.feature_uri = ${sqlLit(featureUri)} AND st.scenario_id = ${sqlLit(scenarioId)}
    ORDER BY st.run_id, st.step_ordinal
  `;
}

/**
 * Resolve a scenario's display name/tags by exact (feature_uri, scenario_id)
 * match, with no join against `runs` - so it's unaffected by the "nightly
 * only" toggle (or any other matrix filter). This is what lets a deep link
 * keep showing its scenario even when the current filters would exclude it.
 */
function buildScenarioIdentitySql(
  featureUri: string,
  scenarioId: string,
): string {
  return `
    SELECT feature_uri, feature_name, scenario_id, scenario_name, tag_names
    FROM scenarios
    WHERE feature_uri = ${sqlLit(featureUri)} AND scenario_id = ${sqlLit(scenarioId)}
    LIMIT 1
  `;
}

/** Whether a URL needs the stability metric's extra data. `status` vs
 *  `duration` is a purely client-side rendering choice over rows the loader
 *  already returns; only `stability` pulls the service-version rows. Shared
 *  with `shouldRevalidate` so the two can't drift apart. */
function needsStabilityData(params: URLSearchParams): boolean {
  return params.get("metric") === "stability";
}

/**
 * Load matrix + (optionally) a selected scenario's history server-side. Mirrors
 * the SPA's conditional loading, keyed on the URL (feature/scenario/metric are
 * all URL params): the matrix cells load for the matrix view and for the detail
 * view's stability metric; a selected scenario also loads its identity/history/
 * step-history. The nightly scope is applied client-side, so everything is
 * fetched for the whole window.
 */
export async function loader({ request }: Route.LoaderArgs) {
  await ensureData();
  const url = new URL(request.url);
  const feature = safeDecodeURIComponent(url.searchParams.get("feature"));
  const scenario = safeDecodeURIComponent(url.searchParams.get("scenario"));
  const wantsSelection = feature !== null && scenario !== null;
  const needsStability = needsStabilityData(url.searchParams);
  const recentRuns = recentRunsFromRequest(request);

  const matrix =
    !wantsSelection || needsStability
      ? await query<MatrixCellRow>(matrixSql(recentRuns))
      : null;
  const versions = needsStability
    ? await query<VersionScopeRow>(serviceVersionsScopeSql(recentRuns))
    : null;
  const [{ total: totalRuns }] = await query<{ total: number }>(
    "SELECT count(*) AS total FROM runs",
  );

  let identity: ScenarioIdentityRow[] | null = null;
  let history: HistoryRow[] | null = null;
  let steps: StepHistoryRow[] | null = null;
  if (wantsSelection) {
    [identity, history, steps] = await Promise.all([
      query<ScenarioIdentityRow>(buildScenarioIdentitySql(feature, scenario)),
      query<HistoryRow>(buildHistorySql(feature, scenario)),
      query<StepHistoryRow>(buildStepHistorySql(feature, scenario)),
    ]);
  }

  return { matrix, versions, identity, history, steps, recentRuns, totalRuns };
}

/** The only search params the loader above reads. Everything else this page
 *  puts in the URL - the search box, the run x status filter, tags, the focused
 *  step - is applied CLIENT-SIDE over data the loader already returned. */
const LOADER_PARAMS = ["feature", "scenario", RUNS_PARAM];

/** What a URL is worth re-fetching for: the params the loader reads, plus the
 *  one metric distinction it actually branches on. */
function loaderKey(url: URL): string {
  return [
    ...LOADER_PARAMS.map((p) => url.searchParams.get(p) ?? ""),
    String(needsStabilityData(url.searchParams)),
  ].join("\u0000");
}

/**
 * Don't re-run the loader for a navigation that only changed a client-side
 * filter. By default any change to the search string revalidates, which made
 * the search box cost a server round-trip PER KEYSTROKE - re-running the matrix
 * query to return byte-identical data - and, because the input was bound to the
 * URL, made every character wait on that response (the dropped keys).
 */
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  // An unchanged URL means an explicit revalidation (UpdateWatcher's Refresh,
  // BuildProgress) rather than a navigation - never suppress those.
  if (currentUrl.toString() === nextUrl.toString())
    return defaultShouldRevalidate;
  if (currentUrl.pathname !== nextUrl.pathname) return defaultShouldRevalidate;
  return loaderKey(currentUrl) !== loaderKey(nextUrl);
}

function formatRunDateTime(runId: string): string {
  const date = runId.slice(0, 10);
  const time = runId.slice(11, 15);
  return /^\d{4}$/.test(time)
    ? `${date} ${time.slice(0, 2)}:${time.slice(2, 4)}`
    : date;
}

function formatDuration(durationS: number | null | undefined): string {
  if (durationS == null) return "—";
  if (durationS < 60) return `${durationS.toFixed(1)}s`;
  const totalSeconds = Math.round(durationS);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

/** Text colour for a duration cell, keyed by the run's status (a failed or
 *  skipped run's duration is truncated, so it must read as non-comparable). */
function durationClass(status: string): string {
  if (status === "failed") return "text-red-600 dark:text-red-400";
  if (status === "skipped") return "text-amber-600 dark:text-amber-400";
  return "text-foreground";
}

/** Foreground text colour per status kind (for the active column header). */
function statusTextClass(kind: StatusKind): string {
  switch (kind) {
    case "passed":
      return "text-emerald-600 dark:text-emerald-400";
    case "failed":
      return "text-red-600 dark:text-red-400";
    case "skipped":
      return "text-amber-600 dark:text-amber-400";
    default:
      return "text-muted-foreground";
  }
}

function Legend() {
  const items: { kind: StatusKind; label: string }[] = [
    { kind: "passed", label: "Passed" },
    { kind: "failed", label: "Failed" },
    { kind: "skipped", label: "Skipped" },
    { kind: "unknown", label: "No data" },
  ];
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      {items.map((item) => (
        <span key={item.kind} className="inline-flex items-center gap-1.5">
          <StatusMark
            kind={item.kind}
            shape="square"
            size={14}
            title={item.label}
          />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function TagChips({
  tags,
  className,
}: {
  tags: string[] | null | undefined;
  className?: string;
}) {
  if (!tags || tags.length === 0) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {tags.map((tag) => (
        <span
          key={tag}
          className="rounded bg-muted px-1.5 py-0.5 text-[10px] leading-tight text-muted-foreground"
        >
          {tag}
        </span>
      ))}
    </span>
  );
}

/**
 * The scenario × run matrix: sticky feature/scenario column on the left, a
 * scrollable body of per-run cells (status marks or durations), and a sticky
 * summary column on the right (pass rate, or avg duration + variability). The
 * left scenario cell opens the scenario's detail view; each body cell links to
 * that run's detail focused on the scenario.
 */
interface HeaderMenu {
  runId: string;
  left: number;
  top: number;
}

const MENU_W = 208;

function ScenarioMatrixImpl({
  groups,
  runIds,
  metric,
  runStats,
  runFlags,
  filterRunId,
  filterStatus,
  onSetFilter,
  onSelect,
}: {
  groups: MatrixGroup[];
  runIds: string[];
  metric: Metric;
  /** Per-run outcome tallies for the header popover. */
  runStats: Map<string, RunStat>;
  /** Per-run deploy flags (by run_id), for classifying stability flips. */
  runFlags: Map<string, RunDeployFlags>;
  /** Active per-run filter (its header shows an underline), or null. */
  filterRunId: string | null;
  filterStatus: StatusKind | null;
  /** Toggle "show only scenarios with <status> in <run>". */
  onSetFilter: (runId: string, status: StatusKind) => void;
  onSelect: (featureUri: string, scenarioId: string) => void;
}) {
  const summaryHeader =
    metric === "status"
      ? "Pass rate"
      : metric === "duration"
        ? "Avg · CV"
        : "Flakiness";
  // Fixed-layout table: the name column is capped (long names truncate) and
  // the summary column is fixed, so the run columns share the remaining width
  // and the table always fills its container. `minTableWidth` scales with the
  // run count so a wide window scrolls instead of cramming the run columns.
  const NAME_W = 320;
  const SUMMARY_W = 132;
  const MIN_RUN_W = metric === "duration" ? 58 : 30;
  const minTableWidth = NAME_W + SUMMARY_W + runIds.length * MIN_RUN_W;

  // Stability mode: collapse each scenario's per-run statuses into status
  // intervals (the bars) + a flaky/total-flips tally (the summary). The bars are
  // rendered as ONE colSpan cell per row so they can span run columns while the
  // rest of the table chrome (row height, header, groups, sticky columns) is
  // shared with status/duration mode.
  const stabilityByScenario = useMemo(() => {
    const m = new Map<
      string,
      { segments: StatusSegment[]; flaky: number; flips: number }
    >();
    if (metric !== "stability") return m;
    for (const g of groups)
      for (const sc of g.scenarios)
        m.set(
          `${sc.feature_uri}::${sc.scenario_id}`,
          buildStatusSegments(sc.cells, runIds, runFlags),
        );
    return m;
  }, [metric, groups, runIds, runFlags]);

  // Hover popover over a run column header. Rendered position:fixed (viewport
  // coords from the header's rect) so it's never clipped by the scroll
  // container and doesn't depend on z-index games with the sticky header. A
  // short close delay lets the pointer travel from header into the popover.
  const [menu, setMenu] = useState<HeaderMenu | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setMenu(null), 150);
  }, [cancelClose]);
  const openMenu = useCallback(
    (runId: string, el: HTMLElement) => {
      cancelClose();
      const r = el.getBoundingClientRect();
      const left = Math.max(
        8,
        Math.min(r.left, window.innerWidth - MENU_W - 8),
      );
      setMenu({ runId, left, top: r.bottom + 2 });
    },
    [cancelClose],
  );

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menu]);

  return (
    <>
      <div className="relative z-0 overflow-x-auto rounded-lg border">
        <table
          className="w-full table-fixed border-separate border-spacing-0 text-xs"
          style={{ minWidth: minTableWidth }}
        >
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-30 w-[320px] border-b border-r bg-muted px-2 py-1.5 text-left font-medium text-muted-foreground">
                Scenario
              </th>
              {runIds.map((runId) => {
                const active = filterStatus != null && runId === filterRunId;
                return (
                  <th
                    key={runId}
                    className="sticky top-0 z-20 border-b bg-muted p-0"
                  >
                    <button
                      type="button"
                      onMouseEnter={(e) => openMenu(runId, e.currentTarget)}
                      onMouseLeave={scheduleClose}
                      onClick={(e) => openMenu(runId, e.currentTarget)}
                      title={runId}
                      className={cn(
                        "relative flex w-full items-center justify-center py-1.5 hover:bg-accent",
                        metric === "status" ? "px-1" : "px-2",
                        active
                          ? cn("font-medium", statusTextClass(filterStatus))
                          : "text-muted-foreground",
                      )}
                    >
                      <span
                        className="inline-block whitespace-nowrap text-[10px]"
                        style={{
                          writingMode: "vertical-rl",
                          transform: "rotate(180deg)",
                        }}
                      >
                        {runId.slice(5, 10)}
                      </span>
                      {active && (
                        <span
                          className={cn(
                            "pointer-events-none absolute inset-x-0 bottom-0 h-0.5",
                            statusDotClass(filterStatus),
                          )}
                        />
                      )}
                    </button>
                  </th>
                );
              })}
              <th className="sticky right-0 top-0 z-30 w-[132px] border-b border-l bg-muted px-2 py-1.5 text-right font-medium text-muted-foreground">
                {summaryHeader}
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <Fragment key={group.feature_name}>
                <tr>
                  <td
                    className="sticky left-0 z-10 truncate border-b border-r bg-muted px-2 py-1 font-medium text-muted-foreground"
                    title={group.feature_name}
                  >
                    {group.feature_name}
                  </td>
                  <td colSpan={runIds.length} className="border-b bg-muted" />
                  <td className="sticky right-0 z-10 border-b border-l bg-muted" />
                </tr>
                {group.scenarios.map((sc) => {
                  const scKey = `${sc.feature_uri}::${sc.scenario_id}`;
                  const stab = stabilityByScenario.get(scKey);
                  return (
                    <tr key={scKey} className="group">
                      <td className="sticky left-0 z-10 border-b border-r bg-card p-0 group-hover:bg-muted">
                        <button
                          type="button"
                          onClick={() =>
                            onSelect(sc.feature_uri, sc.scenario_id)
                          }
                          title={`${sc.scenario_name} — open step history`}
                          className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-muted/60"
                        >
                          <StatusMark
                            kind={statusKindFromScenario(sc.latestStatus)}
                            shape="dot"
                            size={8}
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {sc.scenario_name}
                          </span>
                        </button>
                      </td>
                      {metric === "stability" ? (
                        // One cell spanning all run columns; the status-interval
                        // bars are positioned as a % of it, so they line up with
                        // the header's run columns.
                        <td
                          colSpan={runIds.length}
                          className="border-b p-0 align-middle group-hover:bg-muted"
                        >
                          <StabilityBars
                            segments={stab?.segments ?? []}
                            runCount={runIds.length}
                            label={sc.scenario_name}
                            linkFor={(rid) =>
                              `/runs/${encodeURIComponent(rid)}?scenario=${encodeURIComponent(sc.scenario_id)}`
                            }
                          />
                        </td>
                      ) : (
                        runIds.map((runId) => {
                          const cell = sc.cells.get(runId);
                          // Scenario didn't run in this run: render an explicit
                          // "no data" mark (status) / em-dash (duration) so every
                          // column has a cell and the grid stays aligned.
                          if (!cell) {
                            return metric === "status" ? (
                              <td
                                key={runId}
                                className="border-b p-0.5 text-center group-hover:bg-muted"
                              >
                                <StatusMark
                                  kind="unknown"
                                  shape="square"
                                  size={16}
                                  title="No data"
                                  className="mx-auto"
                                />
                              </td>
                            ) : (
                              <td
                                key={runId}
                                title="No data"
                                className="border-b px-2 py-1 text-center text-muted-foreground group-hover:bg-muted"
                              >
                                —
                              </td>
                            );
                          }
                          const kind = statusKindFromScenario(cell.status);
                          const href = `/runs/${encodeURIComponent(runId)}?scenario=${encodeURIComponent(sc.scenario_id)}`;
                          const tip = `${sc.scenario_name}\n${runId}\n${statusLabel(kind)} · ${formatDuration(cell.duration_s)}`;
                          if (metric === "status") {
                            return (
                              <td
                                key={runId}
                                className="border-b p-0.5 text-center group-hover:bg-muted"
                              >
                                <Link
                                  to={href}
                                  title={tip}
                                  className="mx-auto block w-fit transition-transform hover:scale-125"
                                >
                                  <StatusMark
                                    kind={kind}
                                    shape="square"
                                    size={16}
                                    title=""
                                  />
                                </Link>
                              </td>
                            );
                          }
                          return (
                            <td
                              key={runId}
                              className="border-b px-2 py-1 text-center group-hover:bg-muted"
                            >
                              <Link
                                to={href}
                                title={tip}
                                className={cn(
                                  "block whitespace-nowrap font-mono tabular-nums hover:underline",
                                  durationClass(cell.status),
                                )}
                              >
                                {formatDuration(cell.duration_s)}
                              </Link>
                            </td>
                          );
                        })
                      )}
                      <td className="sticky right-0 z-10 border-b border-l bg-card px-2 py-1 text-right group-hover:bg-muted">
                        {metric === "status" ? (
                          <span className="whitespace-nowrap">
                            <span className="font-medium tabular-nums">
                              {Math.round(sc.passRate * 100)}%
                            </span>
                            <span className="ml-1 text-[10px] text-muted-foreground">
                              {sc.passed}/{sc.total}
                            </span>
                          </span>
                        ) : metric === "duration" ? (
                          <span className="whitespace-nowrap">
                            <span className="font-medium tabular-nums">
                              {sc.durAvg != null
                                ? formatDuration(sc.durAvg)
                                : "—"}
                            </span>
                            <span className="ml-1 text-[10px] text-muted-foreground">
                              {sc.durCv != null
                                ? `±${Math.round(sc.durCv * 100)}%`
                                : "—"}
                            </span>
                          </span>
                        ) : (stab?.flips ?? 0) === 0 ? (
                          <span
                            className="text-muted-foreground"
                            title="No pass/fail flips"
                          >
                            —
                          </span>
                        ) : (
                          <span className="whitespace-nowrap">
                            <span
                              className={cn(
                                "font-medium tabular-nums",
                                stab!.flaky > 0
                                  ? "text-amber-600 dark:text-amber-400"
                                  : "text-foreground",
                              )}
                            >
                              {Math.round((stab!.flaky / stab!.flips) * 100)}%
                            </span>
                            <span className="ml-1 text-[10px] text-muted-foreground">
                              {stab!.flaky}/{stab!.flips}
                            </span>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {menu &&
        (() => {
          const stats = runStats.get(menu.runId) ?? {
            passed: 0,
            failed: 0,
            skipped: 0,
          };
          const rows: { key: StatusKind; label: string; count: number }[] = [
            { key: "passed", label: "Passed", count: stats.passed },
            { key: "failed", label: "Failed", count: stats.failed },
            { key: "skipped", label: "Skipped", count: stats.skipped },
          ];
          return (
            <div
              className="fixed z-50 rounded-lg border bg-popover p-1.5 text-popover-foreground shadow-md"
              style={{ left: menu.left, top: menu.top, width: MENU_W }}
              onMouseEnter={cancelClose}
              onMouseLeave={scheduleClose}
            >
              <div className="px-2 pt-0.5 pb-1 text-xs text-muted-foreground">
                {formatRunDateTime(menu.runId)}
              </div>
              {rows.map((r) => {
                const isActive =
                  filterRunId === menu.runId && filterStatus === r.key;
                const disabled = r.count === 0 && !isActive;
                return (
                  <button
                    key={r.key}
                    type="button"
                    disabled={disabled}
                    onClick={() => {
                      onSetFilter(menu.runId, r.key);
                      setMenu(null);
                    }}
                    title={
                      isActive
                        ? `Showing only scenarios ${r.label.toLowerCase()} in this run — click to clear`
                        : `Show only scenarios ${r.label.toLowerCase()} in this run`
                    }
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-sm",
                      disabled ? "cursor-default opacity-40" : "hover:bg-muted",
                      isActive && "bg-accent font-medium",
                    )}
                  >
                    <span className="inline-flex items-center gap-2">
                      <StatusMark kind={r.key} shape="square" size={12} />
                      {r.label}
                    </span>
                    <span className="font-mono tabular-nums text-muted-foreground">
                      {r.count}
                    </span>
                  </button>
                );
              })}
              <div className="mt-1 border-t pt-1">
                <Link
                  to={`/runs/${encodeURIComponent(menu.runId)}`}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  Open run detail
                  <ArrowRight size={13} />
                </Link>
              </div>
            </div>
          );
        })()}
    </>
  );
}

/** The matrix is ~2.5k cells (scenarios x runs), each with its own <Link>, so
 *  re-rendering it is the page's dominant cost. Memoised on props: while the
 *  deferred search value is unchanged, `groups` keeps its identity and a
 *  keystroke re-renders only the toolbar. */
const ScenarioMatrix = memo(ScenarioMatrixImpl);

interface StepGridRow {
  step_ordinal: number;
  step_label: string;
  is_background: boolean;
  cells: Map<string, StepHistoryRow>;
  passed: number;
  total: number;
  passRate: number;
  /** Mean duration over PASSED runs (failed/skipped step durations are truncated). */
  durAvg: number | null;
  durCv: number | null;
}

function StepGrid({
  runIds,
  stepRows,
  scenarioHistory,
  scenarioId,
  metric,
  runFlags,
}: {
  runIds: string[];
  stepRows: StepHistoryRow[];
  /** Per-run scenario-level outcome, rendered as the grid's second header row
   *  (the "History" strip folded into the step grid). */
  scenarioHistory: HistoryRow[];
  scenarioId: string;
  metric: Metric;
  /** Per-run deploy flags (by run_id), for classifying each step's flips in the
   *  stability view — the same scope-wide flags the scenario matrix uses. */
  runFlags: Map<string, RunDeployFlags>;
}) {
  const historyByRun = useMemo(() => {
    const m = new Map<string, HistoryRow>();
    for (const row of scenarioHistory) m.set(row.run_id, row);
    return m;
  }, [scenarioHistory]);

  const gridRows = useMemo<StepGridRow[]>(() => {
    const byOrdinal = new Map<number, StepGridRow>();
    for (const row of stepRows) {
      let entry = byOrdinal.get(row.step_ordinal);
      if (!entry) {
        entry = {
          step_ordinal: row.step_ordinal,
          step_label: row.step_label,
          is_background: row.is_background,
          cells: new Map(),
          passed: 0,
          total: 0,
          passRate: 0,
          durAvg: null,
          durCv: null,
        };
        byOrdinal.set(row.step_ordinal, entry);
      }
      // stepRows is ordered by run_id ascending, so the last write wins -
      // i.e. the label reflects the most recent run that had this step.
      entry.step_label = row.step_label;
      entry.is_background = row.is_background;
      entry.cells.set(row.run_id, row);
    }
    for (const entry of byOrdinal.values()) {
      const passedDurations: number[] = [];
      for (const cell of entry.cells.values()) {
        entry.total++;
        if (cell.status === "passed") {
          entry.passed++;
          if (cell.duration_s != null) passedDurations.push(cell.duration_s);
        }
      }
      entry.passRate = entry.total > 0 ? entry.passed / entry.total : 0;
      entry.durAvg = passedDurations.length > 0 ? mean(passedDurations) : null;
      const sd = sampleStdDev(passedDurations);
      entry.durCv =
        entry.durAvg != null && entry.durAvg > 0 && sd != null
          ? sd / entry.durAvg
          : null;
    }
    return Array.from(byOrdinal.values()).sort(
      (a, b) => a.step_ordinal - b.step_ordinal,
    );
  }, [stepRows]);

  const bgRows = useMemo(
    () => gridRows.filter((r) => r.is_background),
    [gridRows],
  );
  const bodyRows = useMemo(
    () => gridRows.filter((r) => !r.is_background),
    [gridRows],
  );
  const bgHasFailure = bgRows.some((r) => r.passed < r.total);
  const [showBackground, setShowBackground] = useState(false);

  // Per-step stability: classify each step's status changes across runs into
  // interval bars + a flaky/total-flips tally, exactly like the scenario matrix
  // (a step flip counts as flaky when the run had no suspect deploy). This
  // surfaces churn the scenario view hides — e.g. a scenario that stays failed
  // while the *failing step* moves is two step flips but no scenario flip.
  const stabilityByOrdinal = useMemo(() => {
    const m = new Map<
      number,
      { segments: StatusSegment[]; flaky: number; flips: number }
    >();
    if (metric !== "stability") return m;
    for (const row of gridRows)
      m.set(row.step_ordinal, buildStatusSegments(row.cells, runIds, runFlags));
    return m;
  }, [metric, gridRows, runIds, runFlags]);

  if (gridRows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No step data for this scenario.
      </p>
    );
  }

  const summaryHeader =
    metric === "status"
      ? "Pass rate"
      : metric === "duration"
        ? "Avg · CV"
        : "Flakiness";
  const STEP_W = 320;
  const SUMMARY_W = 132;
  // Fixed height of the run-id header row, so the scenario-history header row
  // below it can stick at exactly this offset (both rows stay pinned on scroll).
  const RUN_HEAD_H = 64;
  const MIN_RUN_W = metric === "duration" ? 58 : 30;
  const minTableWidth = STEP_W + SUMMARY_W + runIds.length * MIN_RUN_W;
  const colCount = runIds.length + 2;

  const renderRow = (row: StepGridRow) => (
    <tr key={row.step_ordinal}>
      <td
        className={cn(
          "sticky left-0 z-10 truncate border-b border-r bg-card px-2 py-1",
          row.is_background && "text-muted-foreground",
        )}
        title={row.step_label}
      >
        {row.step_label}
      </td>
      {metric === "stability" ? (
        // One cell spanning all run columns; the status-interval bars line up
        // with the header's run columns (positioned as a % of the span).
        <td colSpan={runIds.length} className="border-b p-0 align-middle">
          <StabilityBars
            segments={stabilityByOrdinal.get(row.step_ordinal)?.segments ?? []}
            runCount={runIds.length}
            label={row.step_label}
            linkFor={(rid) =>
              `/runs/${encodeURIComponent(rid)}?scenario=${encodeURIComponent(scenarioId)}&step=${row.step_ordinal}`
            }
          />
        </td>
      ) : (
        runIds.map((runId) => {
          const cell = row.cells.get(runId);
          const href = `/runs/${encodeURIComponent(runId)}?scenario=${encodeURIComponent(scenarioId)}&step=${row.step_ordinal}`;
          if (!cell) {
            return metric === "status" ? (
              <td key={runId} className="border-b p-0.5 text-center">
                <StatusMark
                  kind="unknown"
                  shape="square"
                  size={16}
                  title="No data"
                  className="mx-auto"
                />
              </td>
            ) : (
              <td
                key={runId}
                title="No data"
                className="border-b px-2 py-1 text-center text-muted-foreground"
              >
                —
              </td>
            );
          }
          const kind = statusKindFromScenario(cell.status);
          const tip = `${row.step_label}\n${runId}\n${statusLabel(kind)} · ${formatDuration(cell.duration_s)} — open run detail`;
          if (metric === "status") {
            return (
              <td key={runId} className="border-b p-0.5 text-center">
                <Link
                  to={href}
                  title={tip}
                  className="mx-auto block w-fit transition-transform hover:scale-125"
                >
                  <StatusMark kind={kind} shape="square" size={16} title="" />
                </Link>
              </td>
            );
          }
          return (
            <td key={runId} className="border-b px-2 py-1 text-center">
              <Link
                to={href}
                title={tip}
                className={cn(
                  "block whitespace-nowrap font-mono tabular-nums hover:underline",
                  durationClass(cell.status),
                )}
              >
                {formatDuration(cell.duration_s)}
              </Link>
            </td>
          );
        })
      )}
      <td className="sticky right-0 z-10 border-b border-l bg-card px-2 py-1 text-right">
        {metric === "status" ? (
          <span className="whitespace-nowrap">
            <span className="font-medium tabular-nums">
              {Math.round(row.passRate * 100)}%
            </span>
            <span className="ml-1 text-[10px] text-muted-foreground">
              {row.passed}/{row.total}
            </span>
          </span>
        ) : metric === "duration" ? (
          <span className="whitespace-nowrap">
            <span className="font-medium tabular-nums">
              {row.durAvg != null ? formatDuration(row.durAvg) : "—"}
            </span>
            <span className="ml-1 text-[10px] text-muted-foreground">
              {row.durCv != null ? `±${Math.round(row.durCv * 100)}%` : "—"}
            </span>
          </span>
        ) : (
          (() => {
            const stab = stabilityByOrdinal.get(row.step_ordinal);
            return (stab?.flips ?? 0) === 0 ? (
              <span
                className="text-muted-foreground"
                title="No pass/fail flips"
              >
                —
              </span>
            ) : (
              <span className="whitespace-nowrap">
                <span
                  className={cn(
                    "font-medium tabular-nums",
                    stab!.flaky > 0
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-foreground",
                  )}
                >
                  {Math.round((stab!.flaky / stab!.flips) * 100)}%
                </span>
                <span className="ml-1 text-[10px] text-muted-foreground">
                  {stab!.flaky}/{stab!.flips}
                </span>
              </span>
            );
          })()
        )}
      </td>
    </tr>
  );

  return (
    <>
      <div className="relative z-0 overflow-x-auto rounded-lg border">
        <table
          className="w-full table-fixed border-separate border-spacing-0 text-xs"
          style={{ minWidth: minTableWidth }}
        >
          <thead>
            <tr>
              <th
                rowSpan={2}
                className="sticky left-0 top-0 z-30 w-[320px] border-b border-r bg-muted px-2 py-1.5 text-left align-bottom font-medium text-muted-foreground"
              >
                Step
              </th>
              {runIds.map((runId) => (
                <th
                  key={runId}
                  title={runId}
                  style={{ height: RUN_HEAD_H }}
                  className={cn(
                    "sticky top-0 z-20 border-b bg-muted py-1.5 text-center font-normal text-muted-foreground",
                    metric === "status" ? "px-1" : "px-2",
                  )}
                >
                  <span
                    className="inline-block whitespace-nowrap text-[10px]"
                    style={{
                      writingMode: "vertical-rl",
                      transform: "rotate(180deg)",
                    }}
                  >
                    {runId.slice(5, 10)}
                  </span>
                </th>
              ))}
              <th
                rowSpan={2}
                className="sticky right-0 top-0 z-30 w-[132px] border-b border-l bg-muted px-2 py-1.5 text-right align-bottom font-medium text-muted-foreground"
              >
                {summaryHeader}
              </th>
            </tr>
            {/* Scenario-level outcome per run — the "History" strip, folded in as
                a second, greyed header row aligned to the run columns. */}
            <tr>
              {runIds.map((runId) => {
                const hist = historyByRun.get(runId);
                const kind = hist
                  ? statusKindFromScenario(hist.status)
                  : "unknown";
                const href = `/runs/${encodeURIComponent(runId)}?scenario=${encodeURIComponent(scenarioId)}`;
                const tip = hist
                  ? `${runId}\n${formatRunDateTime(runId)}\n${statusLabel(kind)} · ${formatDuration(hist.duration_s)}${hist.is_nightly ? "" : " · manual"}`
                  : `${runId}\nNo data`;
                return (
                  <th
                    key={runId}
                    style={{ top: RUN_HEAD_H }}
                    className="sticky z-20 border-b bg-muted p-0.5 text-center font-normal"
                  >
                    <Link
                      to={href}
                      title={tip}
                      className="mx-auto block w-fit transition-transform hover:scale-125"
                    >
                      <StatusMark
                        kind={kind}
                        shape="square"
                        size={16}
                        title=""
                      />
                    </Link>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {bgRows.length > 0 && (
              <tr>
                <td colSpan={colCount} className="border-b bg-card p-0">
                  <button
                    type="button"
                    onClick={() => setShowBackground((v) => !v)}
                    title={
                      showBackground
                        ? "Hide background steps"
                        : "Show background steps"
                    }
                    className={cn(
                      "flex w-full items-center gap-2 px-2 py-1 text-left text-[11px] hover:bg-muted/40",
                      bgHasFailure
                        ? "text-red-600 dark:text-red-400"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <ChevronRight
                      size={12}
                      className={cn(
                        "shrink-0 transition-transform",
                        showBackground && "rotate-90",
                      )}
                    />
                    <span>
                      {showBackground ? "Hide" : "Show"} {bgRows.length}{" "}
                      background step{bgRows.length === 1 ? "" : "s"}
                      {bgHasFailure ? " · contains a failure" : ""}
                    </span>
                  </button>
                </td>
              </tr>
            )}
            {showBackground && bgRows.map(renderRow)}
            {bodyRows.map(renderRow)}
          </tbody>
        </table>
      </div>
      {metric === "stability" && (
        <p className="mt-2 text-xs text-muted-foreground">
          Bars are each step&apos;s status held across runs; a colour change is
          a flip. A ▲ marks a flaky flip (a pass→fail with no suspect deploy, or
          a fail→pass with no deploy); summary is the flaky share of flips.
        </p>
      )}
    </>
  );
}

/** Fill class for a status marker in the trend chart. */
function statusFillClass(kind: StatusKind): string {
  switch (kind) {
    case "passed":
      return "fill-emerald-500";
    case "failed":
      return "fill-red-500";
    case "skipped":
      return "fill-amber-500";
    default:
      return "fill-zinc-400";
  }
}

/**
 * The scenario's total duration over runs (oldest → newest) as a line, with a
 * shaded p10–p90 band and dashed median drawn from PASSED runs only (a failed
 * run's duration is truncated at the failing step, so it defines no baseline).
 * Each run is a colour-blind-safe status marker (colour + glyph, matching the
 * status strip above), so slow/anomalous and failed runs read at a glance.
 * Dependency-free inline SVG, theme-aware via ink/surface tokens.
 */
function DurationTrend({ rows }: { rows: HistoryRow[] }) {
  const points = useMemo(
    () =>
      rows.filter(
        (r): r is HistoryRow & { duration_s: number } => r.duration_s != null,
      ),
    [rows],
  );

  if (points.length < 2) {
    return (
      <p className="text-sm text-muted-foreground">
        Not enough runs to plot a trend yet.
      </p>
    );
  }

  const W = 880;
  const H = 190;
  const padL = 44;
  const padR = 14;
  const padT = 12;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const maxDur = Math.max(...points.map((p) => p.duration_s));
  const yMax = maxDur * 1.1 || 1;
  const x = (i: number) => padL + (i / (points.length - 1)) * plotW;
  const y = (v: number) => padT + plotH - (v / yMax) * plotH;

  const passedSorted = points
    .filter((p) => p.status === "passed")
    .map((p) => p.duration_s)
    .sort((a, b) => a - b);
  const hasBand = passedSorted.length >= 2;
  const p10 = quantile(passedSorted, 0.1);
  const p50 = quantile(passedSorted, 0.5);
  const p90 = quantile(passedSorted, 0.9);

  const linePath = points
    .map(
      (p, i) =>
        `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.duration_s).toFixed(1)}`,
    )
    .join(" ");

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="Scenario duration per run"
      >
        {/* y reference: baseline + max */}
        <line
          x1={padL}
          y1={y(0)}
          x2={W - padR}
          y2={y(0)}
          className="stroke-border"
          strokeWidth={1}
        />
        <text
          x={padL - 6}
          y={y(0)}
          textAnchor="end"
          dominantBaseline="middle"
          className="fill-muted-foreground text-[10px]"
        >
          0
        </text>
        <text
          x={padL - 6}
          y={y(maxDur)}
          textAnchor="end"
          dominantBaseline="middle"
          className="fill-muted-foreground text-[10px]"
        >
          {formatDurShort(maxDur)}
        </text>

        {/* p10–p90 band + median, from passed runs */}
        {hasBand && (
          <>
            <rect
              x={padL}
              y={y(p90)}
              width={plotW}
              height={Math.max(1, y(p10) - y(p90))}
              className="fill-foreground/[0.06]"
            />
            <line
              x1={padL}
              y1={y(p50)}
              x2={W - padR}
              y2={y(p50)}
              className="stroke-muted-foreground"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
          </>
        )}

        {/* the duration series */}
        <path
          d={linePath}
          className="fill-none stroke-foreground/40"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {points.map((p, i) => {
          const kind = statusKindFromScenario(p.status);
          const cx = x(i);
          const cy = y(p.duration_s);
          const s = 11;
          return (
            <g key={p.run_id}>
              <title>{`${formatRunDateTime(p.run_id)}\n${statusLabel(kind)} · ${formatDuration(p.duration_s)}`}</title>
              <rect
                x={cx - s / 2}
                y={cy - s / 2}
                width={s}
                height={s}
                rx={2}
                className={cn(statusFillClass(kind), "stroke-background")}
                strokeWidth={1.5}
              />
              {kind === "failed" && (
                <rect
                  x={cx - 3}
                  y={cy - 1}
                  width={6}
                  height={2}
                  rx={1}
                  className="fill-white"
                />
              )}
              {kind === "skipped" && (
                <circle cx={cx} cy={cy} r={2} className="fill-white" />
              )}
              {/* enlarged hover target for the native <title> tooltip */}
              <rect
                x={cx - 9}
                y={cy - 9}
                width={18}
                height={18}
                fill="transparent"
              />
            </g>
          );
        })}

        {/* x ends */}
        <text
          x={padL}
          y={H - 6}
          textAnchor="start"
          className="fill-muted-foreground text-[10px]"
        >
          {points[0].run_id.slice(5, 10)}
        </text>
        <text
          x={W - padR}
          y={H - 6}
          textAnchor="end"
          className="fill-muted-foreground text-[10px]"
        >
          {points[points.length - 1].run_id.slice(5, 10)}
        </text>
      </svg>

      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <StatusMark kind="passed" shape="square" size={11} /> Passed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <StatusMark kind="failed" shape="square" size={11} /> Failed
        </span>
        {hasBand ? (
          <span className="ml-auto">
            median {formatDurShort(p50)} · band p10–p90 {formatDurShort(p10)}–
            {formatDurShort(p90)} (passed runs)
          </span>
        ) : (
          <span className="ml-auto">no passed runs for a baseline band</span>
        )}
      </div>
    </div>
  );
}

function ScenarioDetailPanel({
  selected,
  nightlyOnly,
  tags,
  metric,
  setMetric,
  runFlags,
  historyRows,
  stepRows,
}: {
  selected: SelectedScenario;
  nightlyOnly: boolean;
  tags: string[];
  metric: Metric;
  setMetric: (m: Metric) => void;
  /** Per-run deploy flags (by run_id) for the step grid's stability view. */
  runFlags: Map<string, RunDeployFlags>;
  /** This scenario's per-run history + step history, already nightly-filtered
   *  by the parent (see the Scenarios component). */
  historyRows: HistoryRow[];
  stepRows: StepHistoryRow[];
}) {
  const runIds = useMemo(() => historyRows.map((r) => r.run_id), [historyRows]);

  const passRate = useMemo(() => {
    if (historyRows.length === 0) return null;
    const passed = historyRows.filter((r) => r.status === "passed").length;
    return passed / historyRows.length;
  }, [historyRows]);

  // Collapsed duration-trend summary for the header toggle (median + CV over
  // passed runs); null when there aren't enough runs with a duration to plot.
  const trendStats = useMemo(() => {
    const durable = historyRows.filter((r) => r.duration_s != null);
    if (durable.length < 2) return null;
    const passed = durable
      .filter((r) => r.status === "passed")
      .map((r) => r.duration_s as number)
      .sort((a, b) => a - b);
    if (passed.length < 2)
      return { median: null as number | null, cv: null as number | null };
    const m = mean(passed);
    const sd = sampleStdDev(passed);
    return {
      median: quantile(passed, 0.5),
      cv: m > 0 && sd != null ? sd / m : null,
    };
  }, [historyRows]);
  const [trendOpen, setTrendOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card p-4">
        <h2 className="text-base font-semibold">{selected.scenario_name}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {selected.feature_name}
          <span className="ml-2 font-mono text-xs">{selected.feature_uri}</span>
        </p>
        {tags.length > 0 && <TagChips tags={tags} className="mt-2" />}
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-muted-foreground">
            {historyRows.length} run(s){nightlyOnly ? " · nightly only" : ""}
          </span>
          {passRate !== null && (
            <span className="font-medium tabular-nums">
              {Math.round(passRate * 100)}% pass rate
            </span>
          )}
          {trendStats && (
            <button
              type="button"
              onClick={() => setTrendOpen((o) => !o)}
              aria-expanded={trendOpen}
              title={trendOpen ? "Hide duration trend" : "Show duration trend"}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            >
              <Clock size={13} className="shrink-0" />
              {trendStats.median != null ? (
                <>
                  <span className="font-medium tabular-nums text-foreground">
                    {formatDurShort(trendStats.median)}
                  </span>
                  <span>median</span>
                  {trendStats.cv != null && (
                    <>
                      <span className="text-border">·</span>
                      <span className="font-medium tabular-nums text-foreground">
                        ±{Math.round(trendStats.cv * 100)}%
                      </span>
                    </>
                  )}
                </>
              ) : (
                <span>Duration trend</span>
              )}
              <ChevronRight
                size={14}
                className={cn(
                  "shrink-0 transition-transform",
                  trendOpen && "rotate-90",
                )}
              />
            </button>
          )}
        </div>
        {trendOpen && trendStats && (
          <div className="mt-4 border-t pt-4">
            <DurationTrend rows={historyRows} />
          </div>
        )}
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-muted-foreground">
            Step history ({runIds.length} run{runIds.length === 1 ? "" : "s"}) ·
            oldest → newest
          </h3>
          <Legend />
          <div className="inline-flex rounded-md border p-0.5 text-sm">
            {(["status", "duration", "stability"] as Metric[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMetric(m)}
                className={cn(
                  "rounded px-3 py-1 capitalize transition-colors",
                  metric === m
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        <StepGrid
          runIds={runIds}
          stepRows={stepRows}
          scenarioHistory={historyRows}
          scenarioId={selected.scenario_id}
          metric={metric}
          runFlags={runFlags}
        />
      </div>
    </div>
  );
}

export default function Scenarios() {
  const {
    matrix: rawMatrix,
    versions: rawVersions,
    identity,
    history: rawHistory,
    steps: rawSteps,
    recentRuns,
    totalRuns,
  } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();

  // "Show all" keeps every other param (filters, metric, selection, ?run=): the
  // old `?runs=N` template dropped them, silently resetting the page. Capped at
  // what `?runs=` will actually honour (see showAllRunCount).
  const showAllRuns = showAllRunCount(totalRuns);
  const showAllTo = useMemo(() => {
    const next = new URLSearchParams(searchParams);
    next.set(RUNS_PARAM, String(showAllRuns));
    return `?${next}`;
  }, [searchParams, showAllRuns]);

  // Filters + metric live in the URL (alongside the ?feature=&scenario=
  // selection) so they survive deep links and Back navigation. Each is derived
  // from the params; `patchFilters` (their only writer) uses replace so
  // typing/toggling doesn't pile up history. `nightly` defaults on, so its
  // param records only the off state (?nightly=0); `metric` defaults to status.
  const urlSearch = searchParams.get("q") ?? "";
  // Nightly/all-runs scope is a global preference shared across pages (context,
  // not the URL), so it isn't reset when navigating here.
  const { nightlyOnly } = useRunScope();
  // Per-run status filter: show only scenarios with `filterStatus` in run
  // `filterRunId`. Chosen from a run column header's hover popover; generalises
  // the old "failed in last run" to any run × any status.
  const filterRunId = safeDecodeURIComponent(searchParams.get("frun"));
  const filterStatusParam = searchParams.get("fstatus");
  const filterStatus: StatusKind | null =
    filterStatusParam === "passed" ||
    filterStatusParam === "failed" ||
    filterStatusParam === "skipped"
      ? filterStatusParam
      : null;
  const runFilterActive = filterRunId != null && filterStatus != null;
  const metricParam = searchParams.get("metric");
  const metric: Metric =
    metricParam === "duration"
      ? "duration"
      : metricParam === "stability"
        ? "stability"
        : "status";
  const selectedTags = useMemo(
    () => new Set(searchParams.getAll("tag")),
    [searchParams],
  );

  const patchFilters = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          mutate(next);
          return next;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [setSearchParams],
  );
  const setSearch = useCallback(
    (value: string) =>
      patchFilters((p) => (value ? p.set("q", value) : p.delete("q"))),
    [patchFilters],
  );

  // `search` is the DEFERRED value the matrix filters on; `searchInput` is what
  // the box shows. See the hook for why the two are separate.
  const [searchInput, setSearchInput, search] = useUrlBackedTextFilter(
    urlSearch,
    setSearch,
  );
  const setRunFilter = useCallback(
    (runId: string | null, s: StatusKind | null) =>
      patchFilters((p) => {
        if (runId && s) {
          p.set("frun", runId);
          p.set("fstatus", s);
        } else {
          p.delete("frun");
          p.delete("fstatus");
        }
      }),
    [patchFilters],
  );
  // Picking a status in a run column's popover toggles that filter: apply it,
  // or clear it if that exact (run, status) is already active.
  const toggleRunFilter = useCallback(
    (runId: string, s: StatusKind) => {
      const isActive = filterRunId === runId && filterStatus === s;
      setRunFilter(isActive ? null : runId, isActive ? null : s);
    },
    [setRunFilter, filterRunId, filterStatus],
  );
  const setMetric = useCallback(
    (m: Metric) =>
      patchFilters((p) =>
        m === "status" ? p.delete("metric") : p.set("metric", m),
      ),
    [patchFilters],
  );
  const setSelectedTags = useCallback(
    (tags: string[]) =>
      patchFilters((p) => {
        p.delete("tag");
        for (const tag of tags) p.append("tag", tag);
      }),
    [patchFilters],
  );

  // The URL is the single source of truth for the selection. `?feature=&
  // scenario=` present -> detail view; absent -> the matrix.
  const decodedFeatureUri = safeDecodeURIComponent(searchParams.get("feature"));
  const decodedScenarioId = safeDecodeURIComponent(
    searchParams.get("scenario"),
  );
  const wantsSelection =
    decodedFeatureUri !== null && decodedScenarioId !== null;

  // Nightly/all-runs scope applied client-side (the loader fetches the whole
  // window; see MATRIX_SQL). Matrix cells feed the matrix view AND — under the
  // stability metric — the scope-wide deploy flags the step grid needs, so the
  // loader carries them in the detail view too when stability is active.
  const matrixRows = useMemo(
    () => (rawMatrix ?? []).filter((r) => !nightlyOnly || r.is_nightly),
    [rawMatrix, nightlyOnly],
  );
  // Memoised, not a bare `rawVersions ?? []`: that fallback allocates a fresh
  // array on EVERY render, which invalidated `runFlagsByRunId` below, which
  // changed the `runFlags` prop, which defeated ScenarioMatrix's memo - so the
  // whole ~1.7k-cell table re-reconciled on every keystroke even though nothing
  // it renders had changed.
  const versionRows = useMemo(() => rawVersions ?? [], [rawVersions]);

  // Selected scenario's per-run history + step history, nightly-filtered here so
  // the detail panel stays presentational.
  const historyRows = useMemo(
    () => (rawHistory ?? []).filter((r) => !nightlyOnly || r.is_nightly),
    [rawHistory, nightlyOnly],
  );
  const stepRows = useMemo(
    () => (rawSteps ?? []).filter((r) => !nightlyOnly || r.is_nightly),
    [rawSteps, nightlyOnly],
  );

  // Identity is resolved by the loader independently of nightly/search/tag
  // filters, so a deep-linked scenario stays selected even when those filters
  // would hide it from the matrix.
  // Memoised for the same reason as `versionRows` above: `selected` and
  // `selectedTagsList` derive from it, and a fresh array each render would make
  // both change identity on every render of the detail view.
  const identityRows = useMemo(() => identity ?? [], [identity]);

  const selected = useMemo<SelectedScenario | null>(() => {
    const row = identityRows[0];
    if (!row) return null;
    return {
      feature_uri: row.feature_uri,
      feature_name: row.feature_name,
      scenario_id: row.scenario_id,
      scenario_name: row.scenario_name,
    };
  }, [identityRows]);
  const selectedTagsList = useMemo(
    () => toTagArray(identityRows[0]?.tag_names),
    [identityRows],
  );

  // Run columns: every run in scope, oldest -> newest. Derived from the full
  // (unfiltered) matrix so the column set stays put while row filters change.
  // run_id "YYYY-MM-DD-HHMM-..." sorts lexicographically == chronologically.
  const runIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of matrixRows) set.add(r.run_id);
    return Array.from(set).sort();
  }, [matrixRows]);
  const runIndex = useMemo(() => {
    const m = new Map<string, number>();
    runIds.forEach((id, i) => m.set(id, i));
    return m;
  }, [runIds]);

  // Run-level deploy flags for the stability view: derive per-scenario status
  // sequences + per-run new failures from the matrix, then reuse the Services
  // page's suspect logic so "flaky vs deploy-caused" matches that view exactly.
  const runFlagsByRunId = useMemo(() => {
    const byRunId = new Map<string, RunDeployFlags>();
    if (metric !== "stability" || matrixRows.length === 0) return byRunId;

    const statusByScenario = new Map<string, Map<number, string>>();
    const newlyFailedByIdx = new Map<number, Set<string>>();
    const byScenario = new Map<string, [number, string][]>();
    for (const r of matrixRows) {
      const idx = runIndex.get(r.run_id);
      if (idx == null) continue;
      let arr = byScenario.get(r.scenario_id);
      if (!arr) {
        arr = [];
        byScenario.set(r.scenario_id, arr);
      }
      arr.push([idx, r.status]);
    }
    for (const [sid, arr] of byScenario) {
      arr.sort((a, b) => a[0] - b[0]);
      const seq = new Map<number, string>();
      let prev: string | undefined;
      for (const [idx, status] of arr) {
        seq.set(idx, status);
        if (status === "failed" && prev === "passed") {
          let s = newlyFailedByIdx.get(idx);
          if (!s) {
            s = new Set();
            newlyFailedByIdx.set(idx, s);
          }
          s.add(sid);
        }
        prev = status;
      }
      statusByScenario.set(sid, seq);
    }

    const specByService = buildSpecByService(
      versionRows,
      runIndex,
      runIds.length,
    );
    const isSuspect = makeIsSuspectDeploy(statusByScenario, newlyFailedByIdx);
    computeRunDeployFlags(runIds.length, specByService, isSuspect).forEach(
      (flags, idx) => {
        const rid = runIds[idx];
        if (rid) byRunId.set(rid, flags);
      },
    );
    return byRunId;
  }, [metric, matrixRows, versionRows, runIds, runIndex]);

  // Pivot the flat cells into one row per scenario + its summary stats.
  const allScenarios = useMemo<MatrixScenario[]>(() => {
    const byKey = new Map<string, MatrixScenario>();
    for (const r of matrixRows) {
      const key = `${r.feature_uri}::${r.scenario_id}`;
      let sc = byKey.get(key);
      if (!sc) {
        sc = {
          feature_uri: r.feature_uri,
          feature_name: r.feature_name,
          scenario_id: r.scenario_id,
          scenario_name: r.scenario_name,
          tag_names: toTagArray(r.tag_names),
          cells: new Map(),
          latestStatus: "",
          passed: 0,
          total: 0,
          passRate: 0,
          durAvg: null,
          durCv: null,
          durCount: 0,
        };
        byKey.set(key, sc);
      }
      sc.cells.set(r.run_id, { status: r.status, duration_s: r.duration_s });
    }

    for (const sc of byKey.values()) {
      let latestRun = "";
      const passedDurations: number[] = [];
      for (const [runId, cell] of sc.cells) {
        sc.total++;
        if (cell.status === "passed") {
          sc.passed++;
          if (cell.duration_s != null) passedDurations.push(cell.duration_s);
        }
        if (runId > latestRun) {
          latestRun = runId;
          sc.latestStatus = cell.status;
        }
      }
      sc.passRate = sc.total > 0 ? sc.passed / sc.total : 0;
      sc.durCount = passedDurations.length;
      sc.durAvg = passedDurations.length > 0 ? mean(passedDurations) : null;
      const sd = sampleStdDev(passedDurations);
      sc.durCv =
        sc.durAvg != null && sc.durAvg > 0 && sd != null
          ? sd / sc.durAvg
          : null;
    }

    return Array.from(byKey.values()).sort(
      (a, b) =>
        a.feature_name.localeCompare(b.feature_name) ||
        a.scenario_name.localeCompare(b.scenario_name),
    );
  }, [matrixRows]);

  const tagOptions = useMemo(() => {
    const names = new Set<string>();
    for (const sc of allScenarios) for (const t of sc.tag_names) names.add(t);
    return Array.from(names).sort();
  }, [allScenarios]);

  // Per-run outcome tallies for the column-header popover, over ALL scenarios
  // in scope (not the row-filtered set) so the counts describe the run itself.
  const runStats = useMemo(() => {
    const m = new Map<string, RunStat>();
    for (const rid of runIds) m.set(rid, { passed: 0, failed: 0, skipped: 0 });
    for (const sc of allScenarios) {
      for (const [rid, cell] of sc.cells) {
        const s = m.get(rid);
        if (!s) continue;
        if (cell.status === "passed") s.passed++;
        else if (cell.status === "failed") s.failed++;
        else if (cell.status === "skipped") s.skipped++;
      }
    }
    return m;
  }, [allScenarios, runIds]);

  const filteredScenarios = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allScenarios.filter((sc) => {
      if (
        filterRunId &&
        filterStatus &&
        sc.cells.get(filterRunId)?.status !== filterStatus
      )
        return false;
      if (q && !sc.scenario_name.toLowerCase().includes(q)) return false;
      if (
        selectedTags.size > 0 &&
        !sc.tag_names.some((t) => selectedTags.has(t))
      )
        return false;
      return true;
    });
  }, [allScenarios, search, filterRunId, filterStatus, selectedTags]);

  const groups = useMemo(() => {
    const out: MatrixGroup[] = [];
    let current: MatrixGroup | null = null;
    for (const sc of filteredScenarios) {
      if (!current || current.feature_name !== sc.feature_name) {
        current = { feature_name: sc.feature_name, scenarios: [] };
        out.push(current);
      }
      current.scenarios.push(sc);
    }
    return out;
  }, [filteredScenarios]);

  // Select a scenario -> write ?feature=&scenario= (a plain push, so Back
  // returns to the matrix). Preserves the active filter/metric params.
  const selectScenario = useCallback(
    (featureUri: string, scenarioId: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("feature", featureUri);
        next.set("scenario", scenarioId);
        return next;
      });
    },
    [setSearchParams],
  );

  // Return to the matrix as a PUSH (not replace), so the scenario detail stays
  // on the back stack and the browser Back button returns to it.
  const clearSelection = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("feature");
        next.delete("scenario");
        next.delete("step");
        return next;
      },
      { preventScrollReset: true },
    );
  }, [setSearchParams]);

  // Escape returns from the detail view to the matrix.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || !wantsSelection) return;
      clearSelection();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [wantsSelection, clearSelection]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      {selected ? (
        <div className="space-y-4">
          <button
            type="button"
            onClick={clearSelection}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← Back to all scenarios
          </button>
          <ScenarioDetailPanel
            selected={selected}
            nightlyOnly={nightlyOnly}
            tags={selectedTagsList}
            metric={metric}
            setMetric={setMetric}
            runFlags={runFlagsByRunId}
            historyRows={historyRows}
            stepRows={stepRows}
          />
        </div>
      ) : wantsSelection ? (
        <div className="flex h-64 items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground">
          Scenario not found.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-lg font-semibold">Scenarios</h1>
            <div className="inline-flex rounded-md border p-0.5 text-sm">
              {(["status", "duration", "stability"] as Metric[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMetric(m)}
                  className={cn(
                    "rounded px-3 py-1 capitalize transition-colors",
                    metric === m
                      ? "bg-accent font-medium text-accent-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3">
            <div className="relative min-w-[200px] flex-1">
              <Search
                size={14}
                className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="text"
                name="scenario-search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search scenarios…"
                className="w-full rounded border bg-background px-2 py-1.5 pl-7 text-sm outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            {runFilterActive && (
              <span
                className={cn(
                  "inline-flex items-center gap-1 whitespace-nowrap rounded-md py-1 pr-1 pl-2.5 text-sm",
                  statusClasses(filterStatus),
                )}
              >
                {statusLabel(filterStatus)} in {formatRunDateTime(filterRunId)}
                <button
                  type="button"
                  onClick={() => setRunFilter(null, null)}
                  title="Clear filter"
                  className="rounded p-0.5 hover:bg-black/5 dark:hover:bg-white/10"
                >
                  <X size={13} />
                </button>
              </span>
            )}
            <TagFilter
              allTags={tagOptions}
              selected={Array.from(selectedTags)}
              onChange={setSelectedTags}
            />
          </div>

          {groups.length === 0 ? (
            <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
              No scenarios match the current filters.
            </div>
          ) : (
            <>
              <ScenarioMatrix
                groups={groups}
                runIds={runIds}
                metric={metric}
                runStats={runStats}
                runFlags={runFlagsByRunId}
                filterRunId={filterRunId}
                filterStatus={filterStatus}
                onSetFilter={toggleRunFilter}
                onSelect={selectScenario}
              />
              <p className="text-xs text-muted-foreground">
                {filteredScenarios.length} scenario(s) · {runIds.length} run(s),
                oldest → newest.
                {showAllRuns > recentRuns && (
                  <>
                    {" "}
                    Showing the {recentRuns} most recent;{" "}
                    <Link
                      to={showAllTo}
                      preventScrollReset
                      className="underline decoration-dotted underline-offset-2 hover:text-foreground"
                    >
                      show all {showAllRuns}
                    </Link>
                    .
                  </>
                )}
                {metric === "status"
                  ? " Hover a run column to filter by its passed / failed / skipped scenarios. Summary is pass rate over runs shown."
                  : metric === "duration"
                    ? " Cells are per-run duration; summary is the mean ±CV over passed runs only."
                    : " Bars are each scenario's status held across runs; a colour change is a flip. A ▲ marks a flaky flip (a pass→fail with no suspect deploy, or a fail→pass with no deploy); summary is the flaky share of flips."}
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
