import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Check, ChevronRight, ChevronsDownUp, Copy, FileText, History, Link2, Search } from "lucide-react";
import { toast } from "sonner";
import { useE2eData, useE2eQuery } from "~/contexts/E2eDataContext";
import { buildScenarioLogsSql } from "~/lib/e2e-views";
import StatusBadge from "~/components/StatusBadge";
import StatusMark from "~/components/StatusMark";
import Spinner from "~/components/Spinner";
import CluecumberLink from "~/components/CluecumberLink";
import TagFilter from "~/components/TagFilter";
import { statusKindFromRunToken, statusKindFromScenario, statusLabel } from "~/lib/status";
import { scenarioHistoryPath } from "~/lib/format";
import { cn, copyText } from "~/lib/utils";
import { fireCelebration } from "~/lib/celebrate";

interface RunRow {
  run_id: string;
  run_time: string | null;
  status_token: string;
  failed_count: number | null;
  total_count: number | null;
  is_nightly: boolean;
  /** run_id of the newest run in the currently-loaded `runs` table (folded
   *  into this query as a scalar subquery - see the celebration effect
   *  below). The window `runs` is materialized from is always anchored at
   *  "now", so it always contains the actual newest run. */
  newest_run_id: string | null;
}

interface ScenarioRow {
  run_id: string;
  feature_uri: string;
  feature_name: string;
  scenario_id: string;
  scenario_name: string;
  ordinal: number;
  tag_names: string[] | null;
  duration_s: number | null;
  status: string;
  /** 8-digit id parsed from the scenario's after-hook log embedding (see
   *  v_test_ids in e2e-views.ts). Null for backgrounds (never in this table
   *  anyway) or when the log had no "Test ID:" line / extraction failed. */
  test_id: string | null;
}

interface StepRow {
  run_id: string;
  feature_uri: string;
  scenario_id: string;
  scenario_name: string;
  step_label: string;
  step_ordinal: number;
  status: string;
  duration_s: number | null;
  has_error: boolean;
  error_message: string | null;
  /** Glue method signature, e.g. "void com.hartwig.verification.lama.LamaSteps.foo()". */
  glue_location: string | null;
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

/** Reduce a feature uri (e.g. "classpath:features/Foo.feature") to just its
 *  filename for display - strips everything up to and including the last
 *  "/". Falls back to the original string if there's no "/" to strip. */
function featureFileName(uri: string): string {
  const parts = uri.split("/");
  return parts[parts.length - 1] || uri;
}

function formatDate(runId: string): string {
  return runId.slice(0, 10);
}

function formatTime(runTime: string | null | undefined): string {
  if (!runTime || runTime.length !== 4) return "—";
  return `${runTime.slice(0, 2)}:${runTime.slice(2, 4)}`;
}

/** Format seconds as "1.2s" (< 60s) or "1m03s" (>= 60s). */
function formatDuration(durationS: number | null | undefined): string {
  if (durationS == null) return "—";
  if (durationS < 60) return `${durationS.toFixed(1)}s`;
  const totalSeconds = Math.round(durationS);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
}

function TypeBadge({ isNightly }: { isNightly: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        isNightly
          ? "bg-sky-500/15 text-sky-600 dark:text-sky-400"
          : "bg-zinc-500/10 text-muted-foreground"
      )}
    >
      {isNightly ? "Nightly" : "Manual"}
    </span>
  );
}

// Order for surfacing failures first within a feature's scenario list.
const STATUS_SORT_RANK: Record<string, number> = { failed: 0, skipped: 1, passed: 2 };

// Minimum length of a consecutive SAME-status run (all passed, or all skipped)
// before it gets collapsed into a "first … (N hidden) … last" affordance.
// Shorter runs, and any run broken by a status change (incl. a failure), render
// every step normally.
const COLLAPSE_THRESHOLD = 4;

type StepItem =
  | { type: "step"; step: StepRow }
  | { type: "group"; key: number; steps: StepRow[] };

/**
 * Walk a scenario's steps (already ordered by step_ordinal) and fold maximal
 * runs of >= COLLAPSE_THRESHOLD consecutive SAME-status steps (all passed, or
 * all skipped — never a mix) into a single collapsible "group" item. A `failed`
 * step is never grouped, and any status change (passed↔skipped, or a failure)
 * breaks the run. Runs shorter than the threshold are left as plain per-step items.
 */
function buildStepItems(steps: StepRow[]): StepItem[] {
  const items: StepItem[] = [];
  let i = 0;
  while (i < steps.length) {
    const step = steps[i];
    if (step.status === "passed" || step.status === "skipped") {
      const runStatus = step.status;
      let j = i + 1;
      while (j < steps.length && steps[j].status === runStatus) {
        j++;
      }
      const run = steps.slice(i, j);
      if (run.length >= COLLAPSE_THRESHOLD) {
        items.push({ type: "group", key: run[0].step_ordinal, steps: run });
      } else {
        for (const s of run) items.push({ type: "step", step: s });
      }
      i = j;
    } else {
      items.push({ type: "step", step });
      i++;
    }
  }
  return items;
}

function StepList({
  steps,
  focusStepOrdinal,
}: {
  steps: StepRow[];
  /** Step ordinal to scroll to, highlight, and (if failed) auto-expand the error for. One-time per value change. */
  focusStepOrdinal?: number | null;
}) {
  const [openErrors, setOpenErrors] = useState<Set<number>>(new Set());
  // Collapsed groups (>= COLLAPSE_THRESHOLD consecutive passed/skipped steps)
  // that the user has manually expanded, keyed by the group's first step's
  // ordinal (unique within a scenario). A group also renders expanded - even
  // without being in this set - when it contains the currently-focused step;
  // see `containsFocus` below.
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  const stepRefs = useRef<Map<number, HTMLLIElement>>(new Map());

  const toggleError = (ordinal: number) => {
    setOpenErrors((prev) => {
      const next = new Set(prev);
      if (next.has(ordinal)) next.delete(ordinal);
      else next.add(ordinal);
      return next;
    });
  };

  const toggleGroup = (key: number) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Resolve the step focus once its target step is present in `steps` (which
  // may still be loading when this component first mounts). Guarded against
  // an unknown ordinal - no match just means no highlight/scroll, no crash.
  useEffect(() => {
    if (focusStepOrdinal == null) return;
    const step = steps.find((s) => s.step_ordinal === focusStepOrdinal);
    if (!step) return;
    if (step.has_error) {
      setOpenErrors((prev) => (prev.has(focusStepOrdinal) ? prev : new Set(prev).add(focusStepOrdinal)));
    }
    stepRefs.current.get(focusStepOrdinal)?.scrollIntoView({ block: "center" });
  }, [focusStepOrdinal, steps]);

  const items = useMemo(() => buildStepItems(steps), [steps]);

  if (steps.length === 0) {
    return <p className="py-3 pr-4 pl-10 text-xs text-muted-foreground">No steps recorded.</p>;
  }

  const renderStep = (step: StepRow) => {
    const kind = statusKindFromScenario(step.status);
    const errorOpen = openErrors.has(step.step_ordinal);
    const isFocused = focusStepOrdinal === step.step_ordinal;
    return (
      <li
        key={step.step_ordinal}
        ref={(el) => {
          if (el) stepRefs.current.set(step.step_ordinal, el);
          else stepRefs.current.delete(step.step_ordinal);
        }}
        className={cn(
          // pl-10 aligns the step's status dot under the scenario's (which is
          // offset by its chevron + gap); pr-4 keeps the right edge flush.
          "py-1.5 pr-4 pl-10 text-[13px]",
          isFocused && "rounded bg-accent ring-1 ring-inset ring-ring"
        )}
      >
        <div className="flex items-center gap-2">
          <StatusMark kind={kind} shape="dot" size={9} title={statusLabel(kind)} />
          <span className="flex-1 truncate">{step.step_label}</span>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {formatDuration(step.duration_s)}
          </span>
          {step.has_error && (
            <button
              type="button"
              onClick={() => toggleError(step.step_ordinal)}
              className="shrink-0 rounded px-1.5 py-0.5 text-xs text-red-600 hover:bg-red-500/10 dark:text-red-400"
            >
              {errorOpen ? "Hide error" : "Show error"}
            </button>
          )}
        </div>
        {step.has_error && errorOpen && (
          <pre className="mt-1.5 max-h-64 overflow-auto rounded border border-red-500/20 bg-red-500/5 p-2 text-xs whitespace-pre-wrap text-red-700 dark:text-red-300">
            {step.error_message ?? "(no error message)"}
          </pre>
        )}
      </li>
    );
  };

  return (
    <ul className="divide-y divide-border/60 bg-background/40">
      {items.map((item) => {
        if (item.type === "step") return renderStep(item.step);

        // A collapsed group must still render fully open if the deep-linked
        // step (`?step=`) falls inside its hidden middle - otherwise the scroll
        // + highlight effect above would have nothing to find in the DOM.
        const containsFocus =
          focusStepOrdinal != null && item.steps.some((s) => s.step_ordinal === focusStepOrdinal);
        const isExpanded = containsFocus || expandedGroups.has(item.key);
        const hiddenCount = item.steps.length - 2;

        if (isExpanded) {
          return (
            <Fragment key={`group-${item.key}`}>
              {item.steps.map((s) => renderStep(s))}
              <li className="py-1 pr-4 pl-10">
                <button
                  type="button"
                  onClick={() => toggleGroup(item.key)}
                  className="flex w-full items-center gap-2 rounded py-0.5 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                >
                  <ChevronsDownUp size={12} className="shrink-0" />
                  <span className="h-px flex-1 bg-border/60" />
                  <span>collapse {item.steps.length} steps</span>
                  <span className="h-px flex-1 bg-border/60" />
                </button>
              </li>
            </Fragment>
          );
        }

        const first = item.steps[0];
        const last = item.steps[item.steps.length - 1];
        // A run breaks at failures, so the hidden middle is normally all one
        // status (passed or skipped) — name it; fall back to generic if mixed.
        const hiddenStatuses = new Set(
          item.steps.slice(1, -1).map((s) => s.status),
        );
        const hiddenStatusWord =
          hiddenStatuses.size === 1 ? [...hiddenStatuses][0] : null;
        return (
          <Fragment key={`group-${item.key}`}>
            {renderStep(first)}
            <li className="px-4 py-1">
              <button
                type="button"
                onClick={() => toggleGroup(item.key)}
                title={`Show ${hiddenCount} hidden ${hiddenStatusWord ? hiddenStatusWord + " " : ""}step${hiddenCount === 1 ? "" : "s"}`}
                className="flex w-full items-center gap-2 rounded py-0.5 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              >
                <span aria-hidden className="inline-block size-3 shrink-0" />
                <span className="h-px flex-1 bg-border/60" />
                <span className="whitespace-nowrap">
                  {`${hiddenCount} more ${hiddenStatusWord ? hiddenStatusWord + " " : ""}step${hiddenCount === 1 ? "" : "s"} hidden`}
                </span>
                <span className="h-px flex-1 bg-border/60" />
              </button>
            </li>
            {renderStep(last)}
          </Fragment>
        );
      })}
    </ul>
  );
}

function CopyTestIdButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = async () => {
    if (!(await copyText(value))) return;
    setCopied(true);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? "Copied" : "Copy Test ID"}
      className="inline-flex shrink-0 items-center rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {copied ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
    </button>
  );
}

/** Header rendered above an expanded scenario's step list: a LEFT group of
 *  labeled fields (Test ID, Duration, Tags) and a RIGHT group of actions
 *  (History, Log). Always renders - Duration/History/Log are relevant for
 *  every scenario, unlike the test_id/tags fields it used to gate on. */
function ScenarioDetailHeader({
  scenario,
  onSelect,
  isLogOpen,
  logsLoading,
  logsError,
  log,
  onToggleLog,
}: {
  scenario: ScenarioRow;
  /** Select this scenario (writes `?scenario=` to the URL). Used by the "Link"
   *  action, and - with { replace: true } - by "History" just before it
   *  navigates away, so Back returns here with the scenario still selected. */
  onSelect: (opts?: { replace?: boolean }) => void;
  isLogOpen: boolean;
  /** True while this run's scenario logs are being fetched (shared across the
   *  run - only meaningful while `isLogOpen`, since only one scenario's panel
   *  can be open at a time). */
  logsLoading: boolean;
  logsError: Error | null;
  /** This scenario's decoded log text, once loaded; undefined if not (yet)
   *  loaded, null if loaded but this scenario had none. */
  log: string | null | undefined;
  onToggleLog: () => void;
}) {
  const tagList = Array.from(scenario.tag_names ?? []);
  return (
    <div className="border-b bg-muted/20">
      <div className="flex flex-wrap items-center justify-between gap-2 py-1.5 pr-2 pl-10 text-xs">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
          {scenario.test_id && (
            <span className="inline-flex items-center gap-1.5">
              <span>Test ID:</span>
              <span className="font-mono font-medium text-foreground">{scenario.test_id}</span>
              <CopyTestIdButton value={scenario.test_id} />
            </span>
          )}
          <span>
            Duration: <span className="font-mono text-foreground">{formatDuration(scenario.duration_s)}</span>
          </span>
          {tagList.length > 0 && (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <span>Tags:</span>
              <span className="flex flex-wrap gap-1">
                {tagList.map((tag) => (
                  <span
                    key={tag}
                    className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
              </span>
            </span>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => onSelect()}
            title="Link to this scenario (updates the address bar)"
            className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <Link2 size={13} />
            Link
          </button>
          <Link
            to={scenarioHistoryPath(scenario.feature_uri, scenario.scenario_id)}
            // Select this scenario (replacing the current history entry) before
            // leaving, so Back from the history view lands here with it selected.
            onClick={() => onSelect({ replace: true })}
            title="View scenario history"
            className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <History size={13} />
            History
          </Link>
          <button
            type="button"
            onClick={onToggleLog}
            title="View scenario log"
            className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {isLogOpen && logsLoading ? <Spinner size={12} /> : <FileText size={13} />}
            Log
          </button>
        </div>
      </div>
      {isLogOpen && (
        <div className="pr-4 pb-2 pl-10">
          {logsLoading ? (
            <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
              <Spinner size={12} /> Loading log…
            </div>
          ) : logsError || log == null ? (
            <p className="py-2 text-xs text-muted-foreground">Log unavailable.</p>
          ) : (
            <pre className="max-h-96 overflow-auto rounded border bg-background/60 p-2 text-xs whitespace-pre-wrap">
              {log}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function ScenarioRow_({
  scenario,
  isOpen,
  onToggle,
  steps,
  stepsLoading,
  isFocused,
  focusStepOrdinal,
  onSelect,
  isLogOpen,
  logsLoading,
  logsError,
  log,
  onToggleLog,
}: {
  scenario: ScenarioRow;
  isOpen: boolean;
  onToggle: () => void;
  steps: StepRow[];
  stepsLoading: boolean;
  /** True when this scenario is the one targeted by the run detail's `?scenario=` param. */
  isFocused?: boolean;
  /** Step ordinal targeted by the `?step=` param, only meaningful when `isFocused`. */
  focusStepOrdinal?: number | null;
  /** Select this scenario, via the header's "Link"/"History" actions (see ScenarioDetailHeader). */
  onSelect: (opts?: { replace?: boolean }) => void;
  /** Whether THIS scenario's log panel is open. */
  isLogOpen: boolean;
  logsLoading: boolean;
  logsError: Error | null;
  log: string | null | undefined;
  onToggleLog: () => void;
}) {
  const kind = statusKindFromScenario(scenario.status);
  const rowRef = useRef<HTMLLIElement | null>(null);

  // Bring the focused scenario into view once (on mount if already focused,
  // or when it becomes focused via a param change) - guarded so plain
  // expand/collapse interactions never trigger a re-scroll. Only scroll when
  // the row doesn't already reach the middle 75% of the viewport: shrink the
  // check region by 12.5% of the height top and bottom, so a row stuck in an
  // edge band - or fully off-screen on a deep link - gets centered, while one
  // comfortably in the middle is left alone (no jump when clicking its own
  // "Link"). Centering reads best here; "nearest" would edge-align this big
  // expandable card awkwardly at the fold.
  useEffect(() => {
    if (!isFocused) return;
    const el = rowRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const band = window.innerHeight * 0.125;
    const inMiddle = rect.bottom > band && rect.top < window.innerHeight - band;
    if (!inMiddle) el.scrollIntoView({ block: "center" });
  }, [isFocused]);

  return (
    <li
      ref={rowRef}
      // Marks this row for the container's click-away deselect handler, which
      // keeps the selection only when a click lands inside the selected row.
      data-scenario-id={scenario.scenario_id}
      className={cn(isFocused && "rounded-md bg-accent/60 ring-2 ring-ring")}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm hover:bg-muted/40"
      >
        <ChevronRight
          size={14}
          className={cn("shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")}
        />
        <StatusMark kind={kind} shape="dot" size={10} title={statusLabel(kind)} />
        <span className="flex-1 truncate">{scenario.scenario_name}</span>
      </button>
      {isOpen && (
        <div className="border-t">
          <ScenarioDetailHeader
            scenario={scenario}
            onSelect={onSelect}
            isLogOpen={isLogOpen}
            logsLoading={logsLoading}
            logsError={logsError}
            log={log}
            onToggleLog={onToggleLog}
          />
          {stepsLoading ? (
            <div className="flex items-center gap-2 py-3 pr-4 pl-10 text-xs text-muted-foreground">
              <Spinner size={12} /> Loading steps…
            </div>
          ) : (
            <StepList steps={steps} focusStepOrdinal={isFocused ? focusStepOrdinal : null} />
          )}
        </div>
      )}
    </li>
  );
}

export default function RunDetail() {
  const { runId: rawRunId } = useParams();
  const runId = rawRunId ? decodeURIComponent(rawRunId) : "";
  const runIdLit = sqlLit(runId);

  const { detailsReady, status: dataStatus, error: dataError, query, reportUrlByRunId } = useE2eData();
  const [openScenario, setOpenScenario] = useState<string | null>(null);
  const testIdInputRef = useRef<HTMLInputElement | null>(null);

  // Lazy per-run scenario logs (for the header's Log button): fetched once
  // per run on first click, cached by scenario_id. `scenarioLogsRunIdRef`
  // tracks which run the cache (if any) belongs to, so switching runs (or a
  // failed fetch) triggers a fresh load rather than reusing stale data.
  const [scenarioLogs, setScenarioLogs] = useState<Map<string, string | null> | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<Error | null>(null);
  const [openLogScenarioId, setOpenLogScenarioId] = useState<string | null>(null);
  const scenarioLogsRunIdRef = useRef<string | null>(null);

  // Reset the log cache/panel whenever the run changes.
  useEffect(() => {
    scenarioLogsRunIdRef.current = null;
    setScenarioLogs(null);
    setLogsLoading(false);
    setLogsError(null);
    setOpenLogScenarioId(null);
  }, [runId]);

  async function loadScenarioLogsIfNeeded() {
    if (scenarioLogsRunIdRef.current === runId) return; // already loaded/loading for this run
    const reportUrl = reportUrlByRunId[runId];
    if (!reportUrl) {
      setLogsError(new Error("No report URL available for this run"));
      return;
    }
    scenarioLogsRunIdRef.current = runId;
    setLogsLoading(true);
    setLogsError(null);
    try {
      const rows = await query<{ scenario_id: string; log: string | null }>(
        buildScenarioLogsSql(reportUrl)
      );
      setScenarioLogs(new Map(rows.map((r) => [r.scenario_id, r.log])));
    } catch (e) {
      scenarioLogsRunIdRef.current = null; // allow retrying on a later click
      setScenarioLogs(null);
      setLogsError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLogsLoading(false);
    }
  }

  function handleToggleLog(scenarioId: string) {
    if (openLogScenarioId === scenarioId) {
      setOpenLogScenarioId(null);
      return;
    }
    setOpenLogScenarioId(scenarioId);
    void loadScenarioLogsIfNeeded();
  }

  // Cross-navigation focus: `?scenario=<scenario_id>&step=<step_ordinal>`,
  // e.g. from the Scenarios step-history grid/history-strip. `scenario_id` is
  // a Cucumber element id ("<feature-name-slug>;<scenario-name-slug>"), which
  // already embeds the feature and is unique within a single run's report -
  // no feature_uri is needed to disambiguate it here.
  const [searchParams, setSearchParams] = useSearchParams();
  const focusScenarioId = safeDecodeURIComponent(searchParams.get("scenario"));
  const focusStepParam = searchParams.get("step");
  const focusStepOrdinal =
    focusStepParam != null && /^\d+$/.test(focusStepParam) ? Number(focusStepParam) : null;

  // Filters live in the URL so they survive deep links and Back navigation.
  // Each value is derived straight from the search params; `patchFilters` (the
  // sole writer) uses `replace` so toggling/typing doesn't pile up history
  // entries, and `preventScrollReset` so a filter change never jumps the page.
  // Tags use repeated `?tag=` params (no delimiter to escape). `selectedTags`
  // is memoized so its array identity is stable across renders that don't
  // touch the URL - featureGroups depends on it.
  const failuresOnly = searchParams.get("failures") === "1";
  const testIdQuery = searchParams.get("testId") ?? "";
  const selectedTags = useMemo(() => searchParams.getAll("tag"), [searchParams]);

  const patchFilters = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          mutate(next);
          return next;
        },
        { replace: true, preventScrollReset: true }
      );
    },
    [setSearchParams]
  );

  const setFailuresOnly = useCallback(
    (on: boolean) => patchFilters((p) => (on ? p.set("failures", "1") : p.delete("failures"))),
    [patchFilters]
  );
  const setTestIdQuery = useCallback(
    (value: string) => patchFilters((p) => (value ? p.set("testId", value) : p.delete("testId"))),
    [patchFilters]
  );
  const setSelectedTags = useCallback(
    (tags: string[]) =>
      patchFilters((p) => {
        p.delete("tag");
        for (const tag of tags) p.append("tag", tag);
      }),
    [patchFilters]
  );

  // Clear the `?scenario`/`?step` selection, removing the highlight. Shared by
  // the Escape shortcut and the click-away handler. Leaves the row's expand
  // state alone (deselecting isn't collapsing). `replace` so it doesn't leave
  // an extra history entry to Back through; `preventScrollReset` so removing
  // the param doesn't make <ScrollRestoration> jump the page to the top.
  const clearSelection = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("scenario");
        next.delete("step");
        return next;
      },
      { replace: true, preventScrollReset: true }
    );
  }, [setSearchParams]);

  // Select a scenario by writing `?scenario=` (dropping any `?step=` focus,
  // which is a different, step-level deep link). This is the same URL write a
  // deep link from /scenarios produces, so selection and permalinking share
  // one code path. `preventScrollReset` because the focused row scrolls itself
  // into view (see ScenarioRow_) and the default scroll-to-top would fight it.
  //
  // `{ replace: true }` is used by "History" to annotate the entry it's about
  // to leave, so Back returns here with the scenario selected. It can't go
  // through the router: the ensuing Link navigation to /scenarios supersedes a
  // router replace before it commits. So rewrite the current entry directly via
  // the History API (synchronous, and reusing history.state keeps React
  // Router's key/idx intact), preserving any other params already in the URL.
  const selectScenario = useCallback(
    (scenarioId: string, opts?: { replace?: boolean }) => {
      if (opts?.replace) {
        const params = new URLSearchParams(window.location.search);
        params.set("scenario", scenarioId);
        params.delete("step");
        const search = params.toString();
        window.history.replaceState(
          window.history.state,
          "",
          `${window.location.pathname}${search ? `?${search}` : ""}`
        );
        return;
      }
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("scenario", scenarioId);
          next.delete("step");
          return next;
        },
        { preventScrollReset: true }
      );
    },
    [setSearchParams]
  );

  // Two ways to deselect: pressing Escape, or clicking anywhere that isn't
  // inside the selected scenario's row (handleDeselectOnOutsideClick, wired to
  // the page container below). Escape is skipped when the event originates in
  // the test-id search box, so it behaves like an ordinary text input there.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (e.target === testIdInputRef.current) return;
      if (!focusScenarioId && focusStepParam == null) return;
      clearSelection();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [focusScenarioId, focusStepParam, clearSelection]);

  // Click-away deselect: any click that isn't inside the selected scenario's
  // row clears the selection. A document-level listener (not one scoped to the
  // page container) so clicks on the empty margins/background count too. Runs
  // in the CAPTURE phase so that when a click ALSO selects a different scenario
  // - e.g. its "Link" button - this clears the old selection first and the new
  // one, applied on the ensuing bubble-phase onClick, wins. Attached only while
  // something is selected. `data-scenario-id` is stamped on every scenario <li>.
  useEffect(() => {
    if (!focusScenarioId && focusStepParam == null) return;
    function onClick(e: MouseEvent) {
      const target = e.target as Element | null;
      const clickedId = target?.closest?.("[data-scenario-id]")?.getAttribute("data-scenario-id");
      if (clickedId === focusScenarioId) return;
      clearSelection();
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [focusScenarioId, focusStepParam, clearSelection]);

  const {
    rows: runRows,
    loading: runLoading,
    error: runError,
  } = useE2eQuery<RunRow>(
    runId
      ? `SELECT run_id, run_time, status_token, failed_count, total_count, is_nightly,
                (SELECT max(run_id) FROM runs) AS newest_run_id
         FROM runs WHERE run_id = ${runIdLit}`
      : null,
    [runId]
  );

  const {
    rows: scenarios,
    loading: scenariosLoading,
    error: scenariosError,
  } = useE2eQuery<ScenarioRow>(
    detailsReady && runId
      ? `SELECT feature_uri, feature_name, scenario_id, scenario_name, ordinal, tag_names, duration_s, status, test_id
         FROM scenarios WHERE run_id = ${runIdLit}`
      : null,
    [detailsReady, runId]
  );

  // Fetch all steps for the run once; group client-side per scenario on expand.
  const {
    rows: allSteps,
    loading: stepsLoading,
  } = useE2eQuery<StepRow>(
    detailsReady && runId
      ? `SELECT feature_uri, scenario_id, scenario_name, step_label, step_ordinal, status, duration_s, has_error, error_message, glue_location
         FROM steps WHERE run_id = ${runIdLit} ORDER BY scenario_id, step_ordinal`
      : null,
    [detailsReady, runId]
  );

  // Resolve the focused scenario from the run's own scenario list (not the
  // filtered view) so it can be exempted from "failures only"/tag filters
  // below, and so its identity is available before scenarios finish loading.
  const focusedScenario = useMemo(() => {
    if (!focusScenarioId) return null;
    return scenarios.find((s) => s.scenario_id === focusScenarioId) ?? null;
  }, [scenarios, focusScenarioId]);
  const focusedScenarioKey = focusedScenario
    ? `${focusedScenario.feature_uri}::${focusedScenario.scenario_id}`
    : null;

  // Auto-expand the focused scenario once it resolves (initial load, or the
  // `?scenario=` param changing) - not on every re-render, so a user who
  // manually collapses it afterwards isn't fought by this effect.
  useEffect(() => {
    if (focusedScenarioKey) setOpenScenario(focusedScenarioKey);
  }, [focusedScenarioKey]);

  const stepsByScenario = useMemo(() => {
    const map = new Map<string, StepRow[]>();
    for (const step of allSteps) {
      const key = `${step.feature_uri}::${step.scenario_id}`;
      const list = map.get(key);
      if (list) list.push(step);
      else map.set(key, [step]);
    }
    return map;
  }, [allSteps]);

  const scenarioCounts = useMemo(() => {
    const counts = { passed: 0, failed: 0, skipped: 0 };
    for (const s of scenarios) {
      if (s.status === "passed") counts.passed++;
      else if (s.status === "failed") counts.failed++;
      else if (s.status === "skipped") counts.skipped++;
    }
    return counts;
  }, [scenarios]);

  const totalStepCount = allSteps.length;

  // Union of tag_names across every scenario in this run, for the tag filter dropdown.
  const availableTags = useMemo(() => {
    const tags = new Set<string>();
    for (const s of scenarios) {
      for (const t of Array.from(s.tag_names ?? [])) tags.add(t);
    }
    return Array.from(tags).sort();
  }, [scenarios]);

  const trimmedTestIdQuery = testIdQuery.trim().toLowerCase();

  const featureGroups = useMemo(() => {
    const filtered = scenarios.filter((s) => {
      // The scenario targeted by `?scenario=` must always render, regardless
      // of the current filters - e.g. a passed scenario opened from a green
      // step-history cell must still show even with "Failures only" checked.
      if (focusedScenarioKey && `${s.feature_uri}::${s.scenario_id}` === focusedScenarioKey) return true;
      if (failuresOnly && s.status !== "failed" && s.status !== "skipped") return false;
      // Union semantics: keep the scenario if it has ANY of the selected tags.
      // tag_names comes back from duckdb-wasm as a list-like value, not a plain
      // Array (see the Array.from(...) usage in ScenarioRow_ below) - wrap it
      // before calling Array.prototype methods on it.
      if (
        selectedTags.length > 0 &&
        !Array.from(s.tag_names ?? []).some((t) => selectedTags.includes(t))
      ) {
        return false;
      }
      // Case-insensitive substring match on test_id; a scenario with no
      // test_id (background/parse miss) never matches a non-empty query.
      if (trimmedTestIdQuery !== "" && !s.test_id?.toLowerCase().includes(trimmedTestIdQuery)) {
        return false;
      }
      return true;
    });

    const byFeature = new Map<string, { feature_name: string; feature_uri: string; scenarios: ScenarioRow[] }>();
    for (const s of filtered) {
      const g = byFeature.get(s.feature_uri);
      if (g) g.scenarios.push(s);
      else byFeature.set(s.feature_uri, { feature_name: s.feature_name, feature_uri: s.feature_uri, scenarios: [s] });
    }

    for (const g of byFeature.values()) {
      g.scenarios.sort((a, b) => {
        const rankA = STATUS_SORT_RANK[a.status] ?? 3;
        const rankB = STATUS_SORT_RANK[b.status] ?? 3;
        if (rankA !== rankB) return rankA - rankB;
        return a.ordinal - b.ordinal;
      });
    }

    // Surface failures at the *top of the page*, not just within their own
    // feature: order feature groups by their worst-status scenario first
    // (failed < skipped < passed), falling back to feature name.
    return Array.from(byFeature.values()).sort((a, b) => {
      const worstA = Math.min(...a.scenarios.map((s) => STATUS_SORT_RANK[s.status] ?? 3));
      const worstB = Math.min(...b.scenarios.map((s) => STATUS_SORT_RANK[s.status] ?? 3));
      if (worstA !== worstB) return worstA - worstB;
      return a.feature_name.localeCompare(b.feature_name);
    });
  }, [scenarios, failuresOnly, selectedTags, trimmedTestIdQuery, focusedScenarioKey]);

  const run = runRows[0];
  const combinedError = dataError ?? runError ?? scenariosError;

  // Fire a celebration when this run is BOTH the newest run loaded AND a
  // success. Not persisted anywhere - a fresh mount (e.g. a page refresh)
  // celebrates again by design. `celebratedRef` only guards against firing
  // twice within the same mount (React strict-mode's double-invoke, or any
  // other double-render).
  const celebratedRef = useRef(false);
  useEffect(() => {
    if (!run || celebratedRef.current) return;

    const isNewest = run.newest_run_id != null && run.newest_run_id === runId;
    const isSuccess = run.status_token === "ok";
    if (!isNewest || !isSuccess) return;

    celebratedRef.current = true;
    fireCelebration();
    toast.success("🎉 All green — the latest run passed!");
  }, [run, runId]);

  if (dataStatus === "error" || runError || scenariosError) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to Recent Runs
        </Link>
        <p className="text-sm text-destructive">
          Failed to load run{combinedError ? `: ${combinedError.message}` : "."}
        </p>
      </div>
    );
  }

  if (runLoading && !run) {
    return (
      <div className="mx-auto flex max-w-4xl items-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner /> Loading run…
      </div>
    );
  }

  if (!run) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to Recent Runs
        </Link>
        <div className="rounded-lg border bg-card p-6">
          <p className="text-sm text-muted-foreground">
            Run <span className="font-mono">{runId}</span> not found.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back to Recent Runs
      </Link>

      <div className="rounded-lg border bg-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-mono text-lg font-semibold">{run.run_id}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {formatDate(run.run_id)} at {formatTime(run.run_time)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <TypeBadge isNightly={run.is_nightly} />
            <StatusBadge kind={statusKindFromRunToken(run.status_token)} />
            {run.failed_count != null && run.total_count != null && (
              <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
                {run.failed_count} / {run.total_count} failed
              </span>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-4 text-sm">
          {!detailsReady ? (
            <span className="flex items-center gap-2 text-muted-foreground">
              <Spinner size={13} /> Loading scenario details…
            </span>
          ) : (
            <>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-emerald-500" />
                {scenarioCounts.passed} passed
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-red-500" />
                {scenarioCounts.failed} failed
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-amber-500" />
                {scenarioCounts.skipped} skipped
              </span>
              <span className="text-muted-foreground">
                {scenarios.length} scenario(s) · {totalStepCount} step(s)
              </span>
            </>
          )}
        </div>

        <div className="mt-4 border-t pt-3">
          <CluecumberLink runId={run.run_id} label="Cluecumber report" className="text-sm" />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-muted-foreground">Features &amp; scenarios</h2>
        <div className="flex flex-wrap items-center gap-3">
          <TagFilter allTags={availableTags} selected={selectedTags} onChange={setSelectedTags} />
          <div className="relative">
            <Search size={13} className="absolute top-1/2 left-2 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={testIdInputRef}
              type="text"
              name="test-id-search"
              value={testIdQuery}
              onChange={(e) => setTestIdQuery(e.target.value)}
              placeholder="Search test ID…"
              className="w-40 rounded-md border bg-background py-1 pr-2 pl-7 text-sm outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <label className="flex items-center gap-2 text-sm whitespace-nowrap">
            <input
              type="checkbox"
              name="failures-only"
              checked={failuresOnly}
              onChange={(e) => setFailuresOnly(e.target.checked)}
              className="size-3.5 accent-red-500"
            />
            Failures only
          </label>
        </div>
      </div>

      {!detailsReady ? (
        <div className="flex items-center gap-2 rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          <Spinner /> Loading run details…
        </div>
      ) : scenariosLoading && scenarios.length === 0 ? (
        <div className="flex items-center gap-2 rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          <Spinner /> Loading scenarios…
        </div>
      ) : featureGroups.length === 0 ? (
        <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          {failuresOnly || selectedTags.length > 0 || trimmedTestIdQuery !== ""
            ? "No scenarios match the current filters."
            : "No scenarios in this run."}
        </div>
      ) : (
        <div className="space-y-3">
          {featureGroups.map((group) => (
            <div key={group.feature_uri} className="overflow-hidden rounded-lg border bg-card">
              <div className="border-b bg-muted/30 px-4 py-2 text-sm font-medium">
                {group.feature_name}
                <span className="ml-2 font-mono text-xs text-muted-foreground">
                  {featureFileName(group.feature_uri)}
                </span>
              </div>
              <ul className="divide-y">
                {group.scenarios.map((scenario) => {
                  const key = `${scenario.feature_uri}::${scenario.scenario_id}`;
                  const isFocused = focusedScenarioKey === key;
                  return (
                    <ScenarioRow_
                      key={key}
                      scenario={scenario}
                      isOpen={openScenario === key}
                      onToggle={() => setOpenScenario(openScenario === key ? null : key)}
                      steps={stepsByScenario.get(key) ?? []}
                      stepsLoading={stepsLoading && openScenario === key}
                      isFocused={isFocused}
                      focusStepOrdinal={focusStepOrdinal}
                      onSelect={(opts) => selectScenario(scenario.scenario_id, opts)}
                      isLogOpen={openLogScenarioId === scenario.scenario_id}
                      logsLoading={logsLoading}
                      logsError={logsError}
                      log={scenarioLogs?.get(scenario.scenario_id)}
                      onToggleLog={() => handleToggleLog(scenario.scenario_id)}
                    />
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
