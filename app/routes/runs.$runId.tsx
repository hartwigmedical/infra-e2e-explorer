import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Check, ChevronRight, ChevronsDownUp, ChevronsUpDown, Clock, Copy, FileText, History, Link2, Search, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { useE2eData, useE2eQuery } from "~/contexts/E2eDataContext";
import { buildScenarioLogsSql } from "~/lib/e2e-views";
import StatusBadge from "~/components/StatusBadge";
import StatusMark from "~/components/StatusMark";
import RunGantt, { computeRunTiming, formatElapsed } from "~/components/RunGantt";
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
  /** Scenario start as epoch ms (from `started_at`); cast to DOUBLE in SQL so
   *  it arrives as a plain number, not an Arrow int64. Null when the report
   *  had no parseable start_timestamp. Feeds the execution-timeline Gantt. */
  started_ms: number | null;
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
  /** True for steps folded in from the feature's Background (see v_scenarios). */
  is_background: boolean;
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
  revealErrorsToken,
}: {
  steps: StepRow[];
  /** Step ordinal to scroll to, highlight, and (if failed) auto-expand the error for. One-time per value change. */
  focusStepOrdinal?: number | null;
  /** Monotonic counter bumped by the run detail's "reveal failures" action.
   *  Each new value opens every error panel in this list; the user can still
   *  close them individually afterwards. 0/undefined means "never triggered". */
  revealErrorsToken?: number;
}) {
  const [openErrors, setOpenErrors] = useState<Set<number>>(new Set());
  const revealedTokenRef = useRef(0);
  // Collapsed groups (>= COLLAPSE_THRESHOLD consecutive passed/skipped steps)
  // that the user has manually expanded, keyed by the group's first step's
  // ordinal (unique within a scenario). A group also renders expanded - even
  // without being in this set - when it contains the currently-focused step;
  // see `containsFocus` below.
  const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());
  // Background steps (folded in from the feature's Background — see
  // v_scenarios) are hidden behind a "N background steps" affordance by
  // default; this tracks whether the user has opened it.
  const [showBackground, setShowBackground] = useState(false);
  // Step ordinals a hovered "collapse …" control is about to fold away, so we
  // can preview which rows will disappear. null when nothing is hovered.
  const [collapseHoverOrdinals, setCollapseHoverOrdinals] = useState<Set<number> | null>(null);
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
    // A focused background step lives in the collapsed section — open it so the
    // scroll/highlight has something to land on (showBackground is in the deps
    // so this re-runs and scrolls once it's rendered).
    if (step.is_background) setShowBackground(true);
    stepRefs.current.get(focusStepOrdinal)?.scrollIntoView({ block: "center" });
  }, [focusStepOrdinal, steps, showBackground]);

  // "Reveal failures" from the run header: on each new token value, open every
  // error panel in this list. Guarded by a ref so it fires once per token (not
  // again when `steps` re-resolves), leaving later manual closes untouched.
  useEffect(() => {
    if (!revealErrorsToken || revealErrorsToken === revealedTokenRef.current) return;
    revealedTokenRef.current = revealErrorsToken;
    setOpenErrors((prev) => {
      const next = new Set(prev);
      for (const s of steps) if (s.has_error) next.add(s.step_ordinal);
      return next;
    });
    // If a failure is in the (hidden) background, reveal that section too.
    if (steps.some((s) => s.is_background && s.has_error)) setShowBackground(true);
  }, [revealErrorsToken, steps]);

  const bgSteps = useMemo(() => steps.filter((s) => s.is_background), [steps]);
  const bodySteps = useMemo(() => steps.filter((s) => !s.is_background), [steps]);
  const items = useMemo(() => buildStepItems(bodySteps), [bodySteps]);
  const bgHasFailure = bgSteps.some((s) => s.status === "failed");

  if (steps.length === 0) {
    return <p className="py-3 pr-4 pl-10 text-xs text-muted-foreground">No steps recorded.</p>;
  }

  const renderStep = (step: StepRow) => {
    const kind = statusKindFromScenario(step.status);
    const errorOpen = openErrors.has(step.step_ordinal);
    const isFocused = focusStepOrdinal === step.step_ordinal;
    const willCollapse = collapseHoverOrdinals?.has(step.step_ordinal) ?? false;
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
          !isFocused && willCollapse && "bg-muted/70",
          isFocused && "rounded bg-accent ring-1 ring-inset ring-ring"
        )}
      >
        <div className="flex items-center gap-2">
          <StatusMark kind={kind} shape="dot" size={9} title={statusLabel(kind)} />
          <span className={cn("flex-1 truncate", step.is_background && "text-muted-foreground")}>
            {step.step_label}
          </span>
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
    <ul className="divide-y divide-border/60">
      {bgSteps.length > 0 && (
        <Fragment>
          <li className="py-1 pr-4 pl-10">
            <button
              type="button"
              onClick={() => setShowBackground((v) => !v)}
              onMouseEnter={() => {
                if (showBackground) setCollapseHoverOrdinals(new Set(bgSteps.map((s) => s.step_ordinal)));
              }}
              onMouseLeave={() => setCollapseHoverOrdinals(null)}
              title={showBackground ? "Collapse background steps" : "Show background steps"}
              className={cn(
                "flex w-full items-center gap-2 rounded py-0.5 text-xs hover:bg-muted/40",
                !showBackground && bgHasFailure
                  ? "text-red-600 hover:text-red-700 dark:text-red-400"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {showBackground ? (
                <ChevronsDownUp size={12} className="shrink-0" />
              ) : (
                <ChevronsUpDown size={12} className="shrink-0" />
              )}
              <span className="h-px flex-1 bg-border/60" />
              <span className="whitespace-nowrap">
                {showBackground
                  ? `collapse ${bgSteps.length} background step${bgSteps.length === 1 ? "" : "s"}`
                  : `${bgSteps.length} background step${bgSteps.length === 1 ? "" : "s"} hidden${bgHasFailure ? " · contains a failure" : ""}`}
              </span>
              <span className="h-px flex-1 bg-border/60" />
            </button>
          </li>
          {showBackground && bgSteps.map((s) => renderStep(s))}
        </Fragment>
      )}
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
                  onMouseEnter={() => setCollapseHoverOrdinals(new Set(item.steps.map((s) => s.step_ordinal)))}
                  onMouseLeave={() => setCollapseHoverOrdinals(null)}
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
            <li className="py-1 pr-4 pl-10">
              <button
                type="button"
                onClick={() => toggleGroup(item.key)}
                title={`Show ${hiddenCount} hidden ${hiddenStatusWord ? hiddenStatusWord + " " : ""}step${hiddenCount === 1 ? "" : "s"}`}
                className="flex w-full items-center gap-2 rounded py-0.5 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              >
                <ChevronsUpDown size={12} className="shrink-0" />
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

/** The Test ID + Tags line shown directly under an expanded scenario's title,
 *  as part of the row header (above the steps' shaded content area). Renders
 *  nothing when the scenario has neither a test_id nor tags. */
function ScenarioMeta({ scenario }: { scenario: ScenarioRow }) {
  const tagList = Array.from(scenario.tag_names ?? []);
  if (!scenario.test_id && tagList.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-2 pl-10 text-xs text-muted-foreground">
      {scenario.test_id && (
        <span className="inline-flex items-center gap-1.5">
          <span>Test ID:</span>
          <span className="font-mono font-medium text-foreground">{scenario.test_id}</span>
          <CopyTestIdButton value={scenario.test_id} />
        </span>
      )}
      {tagList.length > 0 && (
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
      )}
    </div>
  );
}

/** The scenario log panel, shown at the top of the shaded content area when
 *  its Log action is toggled on. Renders nothing while closed. */
function ScenarioLog({
  isLogOpen,
  logsLoading,
  logsError,
  log,
}: {
  isLogOpen: boolean;
  /** True while this run's scenario logs are being fetched. The fetch loads
   *  every scenario's log in a single query, so this is a run-level flag
   *  shared by all open log panels; only meaningful while `isLogOpen`. */
  logsLoading: boolean;
  logsError: Error | null;
  /** This scenario's decoded log text, once loaded; undefined if not (yet)
   *  loaded, null if loaded but this scenario had none. */
  log: string | null | undefined;
}) {
  if (!isLogOpen) return null;
  return (
    <div className="pr-4 pt-2 pb-2 pl-10">
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
  revealErrorsToken,
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
  /** Bumped by the run header's "reveal failures" action to open error panels. */
  revealErrorsToken?: number;
  /** Select this scenario, via the row's "Link"/"History" title-line actions. */
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
      <div className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-muted/40">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            size={14}
            className={cn("shrink-0 text-muted-foreground transition-transform", isOpen && "rotate-90")}
          />
          <StatusMark kind={kind} shape="dot" size={10} title={statusLabel(kind)} />
          <span className="min-w-0 flex-1 truncate">{scenario.scenario_name}</span>
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {formatDuration(scenario.duration_s)}
          </span>
        </button>
        {/* Row actions live on the title line (only while expanded) instead of
            a separate header band. Test ID + tags render just below the title
            (still part of the header); the steps sit in a shaded content area. */}
        {isOpen && (
          <div className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
            <button
              type="button"
              onClick={() => onSelect()}
              title="Link to this scenario (updates the address bar)"
              className="inline-flex items-center rounded p-1 hover:bg-muted hover:text-foreground"
            >
              <Link2 size={14} />
            </button>
            <Link
              to={scenarioHistoryPath(scenario.feature_uri, scenario.scenario_id)}
              // Select this scenario (replacing the current history entry) before
              // leaving, so Back from the history view lands here with it selected.
              onClick={() => onSelect({ replace: true })}
              title="View scenario history"
              className="inline-flex items-center rounded p-1 hover:bg-muted hover:text-foreground"
            >
              <History size={14} />
            </Link>
            <button
              type="button"
              onClick={onToggleLog}
              title="View scenario log"
              className={cn(
                "inline-flex items-center rounded p-1 hover:bg-muted hover:text-foreground",
                isLogOpen && "bg-muted text-foreground"
              )}
            >
              {isLogOpen && logsLoading ? <Spinner size={14} /> : <FileText size={14} />}
            </button>
          </div>
        )}
      </div>
      {isOpen && <ScenarioMeta scenario={scenario} />}
      {isOpen && (
        <div className="border-t bg-muted/50">
          <ScenarioLog
            isLogOpen={isLogOpen}
            logsLoading={logsLoading}
            logsError={logsError}
            log={log}
          />
          {stepsLoading ? (
            <div className="flex items-center gap-2 py-3 pr-4 pl-10 text-xs text-muted-foreground">
              <Spinner size={12} /> Loading steps…
            </div>
          ) : (
            <StepList
              steps={steps}
              focusStepOrdinal={isFocused ? focusStepOrdinal : null}
              revealErrorsToken={revealErrorsToken}
            />
          )}
        </div>
      )}
    </li>
  );
}

// Module-level (not per-mount) so the celebration fires at most ONCE per page
// load: it survives SPA navigation/remounts - opening a run detail again, or
// hopping run→run, won't re-fire - and only resets on a full page refresh.
let hasCelebrated = false;

export default function RunDetail() {
  const { runId: rawRunId } = useParams();
  const runId = rawRunId ? decodeURIComponent(rawRunId) : "";
  const runIdLit = sqlLit(runId);

  const {
    runsReady,
    detailsReady,
    status: dataStatus,
    error: dataError,
    query,
    reportUrlByRunId,
    windowLabel,
    nextWindowLabel,
    hasMore,
    loadingMore,
    loadMore,
  } = useE2eData();
  // Which scenarios are expanded, keyed by `${feature_uri}::${scenario_id}`.
  // A Set (rather than a single key) so several can be open at once - this is
  // purely expand/collapse state and is independent of the `?scenario=`
  // selection (highlight / click-away / Escape), which lives in the URL.
  const [openScenarios, setOpenScenarios] = useState<Set<string>>(new Set());
  // Bumped by "reveal failures" to signal each open StepList to show its error
  // panels; the failed scenarios are expanded in the same click (see below).
  const [revealErrorsToken, setRevealErrorsToken] = useState(0);
  // The execution-timeline Gantt is collapsed by default (the page's job is
  // browsing scenarios/steps); a compact wall-clock + parallelism toggle in
  // the run header expands it on demand. Persists across run navigation.
  const [timelineOpen, setTimelineOpen] = useState(false);
  const testIdInputRef = useRef<HTMLInputElement | null>(null);

  const toggleScenario = useCallback((key: string) => {
    setOpenScenarios((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Lazy per-run scenario logs (for the header's Log button): fetched once
  // per run on first click, cached by scenario_id. `scenarioLogsRunIdRef`
  // tracks which run the cache (if any) belongs to, so switching runs (or a
  // failed fetch) triggers a fresh load rather than reusing stale data.
  const [scenarioLogs, setScenarioLogs] = useState<Map<string, string | null> | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<Error | null>(null);
  // Which scenarios' log panels are open, by scenario_id. A Set so any number
  // can be open at once, independent of expand and of the `?scenario=`
  // selection - opening a log neither collapses nor selects anything.
  const [openLogScenarioIds, setOpenLogScenarioIds] = useState<Set<string>>(new Set());
  const scenarioLogsRunIdRef = useRef<string | null>(null);

  // Reset the log cache/panels whenever the run changes.
  useEffect(() => {
    scenarioLogsRunIdRef.current = null;
    setScenarioLogs(null);
    setLogsLoading(false);
    setLogsError(null);
    setOpenLogScenarioIds(new Set());
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
    const willOpen = !openLogScenarioIds.has(scenarioId);
    setOpenLogScenarioIds((prev) => {
      const next = new Set(prev);
      if (next.has(scenarioId)) next.delete(scenarioId);
      else next.add(scenarioId);
      return next;
    });
    // Logs are fetched once for the whole run (one query, all scenarios), so
    // only kick the load when opening a panel - closing needs nothing.
    if (willOpen) void loadScenarioLogsIfNeeded();
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
      ? `SELECT feature_uri, feature_name, scenario_id, scenario_name, ordinal, tag_names, duration_s,
                epoch_ms(started_at)::DOUBLE AS started_ms, status, test_id
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
      ? `SELECT feature_uri, scenario_id, scenario_name, step_label, step_ordinal, status, duration_s, has_error, error_message, is_background, glue_location
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
    if (!focusedScenarioKey) return;
    setOpenScenarios((prev) => (prev.has(focusedScenarioKey) ? prev : new Set(prev).add(focusedScenarioKey)));
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

  // Wall-clock + avg-parallelism summary for the collapsed header toggle; null
  // (toggle hidden) when there aren't enough placeable scenarios to draw the
  // timeline at all - matches RunGantt's own render guard.
  const runTiming = useMemo(() => computeRunTiming(scenarios), [scenarios]);

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

  // Keys of every scenario currently visible (post-filter), for expand-all.
  const visibleScenarioKeys = useMemo(
    () =>
      featureGroups.flatMap((g) =>
        g.scenarios.map((s) => `${s.feature_uri}::${s.scenario_id}`)
      ),
    [featureGroups]
  );
  const allExpanded =
    visibleScenarioKeys.length > 0 &&
    visibleScenarioKeys.every((k) => openScenarios.has(k));
  const noneExpanded = visibleScenarioKeys.every((k) => !openScenarios.has(k));

  // Keys of the visible failed scenarios, for the "reveal failures" shortcut.
  const failedScenarioKeys = useMemo(
    () =>
      featureGroups.flatMap((g) =>
        g.scenarios
          .filter((s) => s.status === "failed")
          .map((s) => `${s.feature_uri}::${s.scenario_id}`)
      ),
    [featureGroups]
  );

  // Expand every failed scenario (additively - passed rows already open stay
  // open) and bump the token so their step lists reveal all error panels.
  const revealFailures = useCallback(() => {
    if (failedScenarioKeys.length === 0) return;
    setOpenScenarios((prev) => {
      const next = new Set(prev);
      for (const k of failedScenarioKeys) next.add(k);
      return next;
    });
    setRevealErrorsToken((t) => t + 1);
  }, [failedScenarioKeys]);

  const run = runRows[0];
  const combinedError = dataError ?? runError ?? scenariosError;

  // Fire a celebration when this run is BOTH the newest run loaded AND a
  // success - but only the first time per page load (see `hasCelebrated`), so
  // reopening a run detail or navigating run→run doesn't re-fire; a full page
  // refresh resets the flag and celebrates again.
  useEffect(() => {
    if (!run || hasCelebrated) return;

    const isNewest = run.newest_run_id != null && run.newest_run_id === runId;
    const isSuccess = run.status_token === "ok";
    if (!isNewest || !isSuccess) return;

    hasCelebrated = true;
    fireCelebration();
    toast.success("🎉 All green — the latest run passed!");
  }, [run, runId]);

  if (dataStatus === "error" || runError || scenariosError) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <p className="text-sm text-destructive">
          Failed to load run{combinedError ? `: ${combinedError.message}` : "."}
        </p>
      </div>
    );
  }

  // Show "Loading" (not "not found") whenever the run row can't be known yet:
  // the runs table isn't ready, or the lookup is still in flight. Guarding on
  // `!run` too means an already-loaded run isn't blanked during a soft reload.
  if ((!runsReady || runLoading) && !run) {
    return (
      <div className="mx-auto flex max-w-4xl items-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner /> Loading run…
      </div>
    );
  }

  if (!run) {
    // A run can be absent simply because it predates the loaded window (the
    // runs table is materialized for a rolling date range - see E2eDataContext).
    // Offer to widen the window before concluding it doesn't exist; only once
    // everything is loaded (`!canLoadMore`) is it truly "not found".
    const canLoadMore = hasMore && nextWindowLabel != null;
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <div className="rounded-lg border bg-card p-6">
          {canLoadMore ? (
            <>
              <p className="text-sm text-muted-foreground">
                Run <span className="font-mono">{runId}</span> isn't in the loaded data. It may be
                older than the current <span className="font-medium">{windowLabel}</span> window.
              </p>
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="mt-3 inline-flex items-center justify-center gap-2 rounded-md border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted/50 disabled:opacity-60"
              >
                {loadingMore && <Spinner size={13} />}
                {loadingMore ? "Loading…" : `Load ${nextWindowLabel}`}
              </button>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Run <span className="font-mono">{runId}</span> not found.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-6">
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
            <CluecumberLink runId={run.run_id} label="Report" className="text-sm" />
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
              {runTiming && (
                <button
                  type="button"
                  onClick={() => setTimelineOpen((open) => !open)}
                  aria-expanded={timelineOpen}
                  title={timelineOpen ? "Hide execution timeline" : "Show execution timeline"}
                  className="ml-auto inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                >
                  <Clock size={13} className="shrink-0" />
                  <span className="font-medium tabular-nums text-foreground">
                    {formatElapsed(runTiming.makespanMs)}
                  </span>
                  <span>wall-clock</span>
                  <span className="text-border">·</span>
                  <span className="font-medium tabular-nums text-foreground">
                    {runTiming.avgParallelism.toFixed(1)}×
                  </span>
                  <span>parallel</span>
                  <ChevronRight
                    size={14}
                    className={cn("shrink-0 transition-transform", timelineOpen && "rotate-90")}
                  />
                </button>
              )}
            </>
          )}
        </div>

        {detailsReady && timelineOpen && scenarios.length > 1 && (
          <div className="mt-4 border-t pt-4">
            <RunGantt
              scenarios={scenarios}
              focusedScenarioId={focusScenarioId}
              onSelectScenario={(id) => selectScenario(id)}
            />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5">
          <h2 className="text-sm font-semibold text-muted-foreground">Features &amp; scenarios</h2>
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => setOpenScenarios(new Set(visibleScenarioKeys))}
              disabled={allExpanded}
              title="Expand all scenarios"
              className="inline-flex items-center rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <ChevronsUpDown size={14} />
            </button>
            <button
              type="button"
              onClick={() => setOpenScenarios(new Set())}
              disabled={noneExpanded}
              title="Collapse all scenarios"
              className="inline-flex items-center rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <ChevronsDownUp size={14} />
            </button>
            <span aria-hidden className="mx-1 h-4 w-px bg-border" />
            <button
              type="button"
              onClick={revealFailures}
              disabled={failedScenarioKeys.length === 0}
              title="Expand all failed scenarios and show their errors"
              className="inline-flex items-center rounded p-1 text-red-600 hover:bg-red-500/10 disabled:pointer-events-none disabled:opacity-40 dark:text-red-400"
            >
              <TriangleAlert size={14} />
            </button>
          </div>
        </div>
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
                      isOpen={openScenarios.has(key)}
                      onToggle={() => toggleScenario(key)}
                      steps={stepsByScenario.get(key) ?? []}
                      stepsLoading={stepsLoading && openScenarios.has(key)}
                      isFocused={isFocused}
                      focusStepOrdinal={focusStepOrdinal}
                      revealErrorsToken={revealErrorsToken}
                      onSelect={(opts) => selectScenario(scenario.scenario_id, opts)}
                      isLogOpen={openLogScenarioIds.has(scenario.scenario_id)}
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
