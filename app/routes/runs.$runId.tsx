import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ChevronRight, ChevronsDownUp, History, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { useE2eData, useE2eQuery } from "~/contexts/E2eDataContext";
import StatusBadge from "~/components/StatusBadge";
import StatusMark from "~/components/StatusMark";
import Spinner from "~/components/Spinner";
import CluecumberLink from "~/components/CluecumberLink";
import TagFilter from "~/components/TagFilter";
import { statusKindFromRunToken, statusKindFromScenario, statusLabel } from "~/lib/status";
import { scenarioHistoryPath } from "~/lib/format";
import { cn } from "~/lib/utils";
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

// Minimum length of a consecutive passed/skipped run before it gets collapsed
// into a "first … (N hidden) … last" affordance. Shorter runs (and any run
// broken up by a failed step) render every step normally.
const COLLAPSE_THRESHOLD = 4;

type StepItem =
  | { type: "step"; step: StepRow }
  | { type: "group"; key: number; steps: StepRow[] };

/**
 * Walk a scenario's steps (already ordered by step_ordinal) and fold maximal
 * runs of >= COLLAPSE_THRESHOLD consecutive passed/skipped steps into a single
 * collapsible "group" item. A `failed` step is never part of a group - it's
 * always its own item, and it breaks whatever passed/skipped run precedes it.
 * Runs shorter than the threshold are left as plain per-step items so the UI
 * never collapses 1-3 steps.
 */
function buildStepItems(steps: StepRow[]): StepItem[] {
  const items: StepItem[] = [];
  let i = 0;
  while (i < steps.length) {
    const step = steps[i];
    if (step.status === "passed" || step.status === "skipped") {
      let j = i + 1;
      while (j < steps.length && (steps[j].status === "passed" || steps[j].status === "skipped")) {
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
    return <p className="px-4 py-3 text-xs text-muted-foreground">No steps recorded.</p>;
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
          "px-4 py-1.5 text-sm",
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
    <ul className="divide-y divide-border/60 border-t bg-background/40">
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
              <li className="px-4 py-1">
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
        return (
          <Fragment key={`group-${item.key}`}>
            {renderStep(first)}
            <li className="px-4 py-1">
              <button
                type="button"
                onClick={() => toggleGroup(item.key)}
                title={`Show ${hiddenCount} hidden step${hiddenCount === 1 ? "" : "s"}`}
                className="flex w-full items-center gap-2 rounded py-0.5 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              >
                <MoreHorizontal size={12} className="shrink-0" />
                <span className="h-px flex-1 bg-border/60" />
                <span className="whitespace-nowrap">
                  ··· {hiddenCount} more step{hiddenCount === 1 ? "" : "s"} hidden ···
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

function ScenarioRow_({
  scenario,
  isOpen,
  onToggle,
  steps,
  stepsLoading,
  isFocused,
  focusStepOrdinal,
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
}) {
  const kind = statusKindFromScenario(scenario.status);
  const rowRef = useRef<HTMLLIElement | null>(null);

  // Scroll the focused scenario into view once (on mount if already focused,
  // or when it becomes focused via a param change) - guarded so plain
  // expand/collapse interactions never trigger a re-scroll.
  useEffect(() => {
    if (isFocused) rowRef.current?.scrollIntoView({ block: "center" });
  }, [isFocused]);

  return (
    <li ref={rowRef} className={cn(isFocused && "rounded-md bg-accent/60 ring-2 ring-ring")}>
      <div className="flex w-full items-center gap-1 px-4 py-2 text-sm hover:bg-muted/40">
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
          <span className="flex-1 truncate">{scenario.scenario_name}</span>
          {scenario.tag_names && scenario.tag_names.length > 0 && (
            <span className="hidden shrink-0 gap-1 sm:flex">
              {Array.from(scenario.tag_names).slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </span>
          )}
          <span className="shrink-0 font-mono text-xs text-muted-foreground">
            {formatDuration(scenario.duration_s)}
          </span>
        </button>
        <Link
          to={scenarioHistoryPath(scenario.feature_uri, scenario.scenario_id)}
          title="View scenario history"
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <History size={14} />
        </Link>
      </div>
      {isOpen && (
        <div>
          {stepsLoading ? (
            <div className="flex items-center gap-2 border-t px-4 py-3 text-xs text-muted-foreground">
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

  const { detailsReady, status: dataStatus, error: dataError } = useE2eData();
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [openScenario, setOpenScenario] = useState<string | null>(null);

  // Cross-navigation focus: `?scenario=<scenario_id>&step=<step_ordinal>`,
  // e.g. from the Scenarios step-history grid/history-strip. `scenario_id` is
  // a Cucumber element id ("<feature-name-slug>;<scenario-name-slug>"), which
  // already embeds the feature and is unique within a single run's report -
  // no feature_uri is needed to disambiguate it here.
  const [searchParams] = useSearchParams();
  const focusScenarioId = safeDecodeURIComponent(searchParams.get("scenario"));
  const focusStepParam = searchParams.get("step");
  const focusStepOrdinal =
    focusStepParam != null && /^\d+$/.test(focusStepParam) ? Number(focusStepParam) : null;

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
      ? `SELECT feature_uri, feature_name, scenario_id, scenario_name, ordinal, tag_names, duration_s, status
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
      ? `SELECT feature_uri, scenario_id, scenario_name, step_label, step_ordinal, status, duration_s, has_error, error_message
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
  }, [scenarios, failuresOnly, selectedTags, focusedScenarioKey]);

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
          {failuresOnly || selectedTags.length > 0
            ? "No scenarios match the current filters."
            : "No scenarios in this run."}
        </div>
      ) : (
        <div className="space-y-3">
          {featureGroups.map((group) => (
            <div key={group.feature_uri} className="overflow-hidden rounded-lg border bg-card">
              <div className="border-b bg-muted/30 px-4 py-2 text-sm font-medium">
                {group.feature_name}
                <span className="ml-2 font-mono text-xs text-muted-foreground">{group.feature_uri}</span>
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
