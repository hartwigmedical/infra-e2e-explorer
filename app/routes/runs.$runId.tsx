import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ChevronRight, History } from "lucide-react";
import { useE2eData, useE2eQuery } from "~/contexts/E2eDataContext";
import StatusBadge from "~/components/StatusBadge";
import StatusMark from "~/components/StatusMark";
import Spinner from "~/components/Spinner";
import CluecumberLink from "~/components/CluecumberLink";
import TagFilter from "~/components/TagFilter";
import { statusKindFromRunToken, statusKindFromScenario, statusLabel } from "~/lib/status";
import { scenarioHistoryPath } from "~/lib/format";
import { cn } from "~/lib/utils";

interface RunRow {
  run_id: string;
  run_time: string | null;
  status_token: string;
  failed_count: number | null;
  total_count: number | null;
  is_nightly: boolean;
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

function StepList({ steps }: { steps: StepRow[] }) {
  const [openErrors, setOpenErrors] = useState<Set<number>>(new Set());

  const toggleError = (ordinal: number) => {
    setOpenErrors((prev) => {
      const next = new Set(prev);
      if (next.has(ordinal)) next.delete(ordinal);
      else next.add(ordinal);
      return next;
    });
  };

  if (steps.length === 0) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">No steps recorded.</p>;
  }

  return (
    <ul className="divide-y divide-border/60 border-t bg-background/40">
      {steps.map((step) => {
        const kind = statusKindFromScenario(step.status);
        const errorOpen = openErrors.has(step.step_ordinal);
        return (
          <li key={step.step_ordinal} className="px-4 py-1.5 text-sm">
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
}: {
  scenario: ScenarioRow;
  isOpen: boolean;
  onToggle: () => void;
  steps: StepRow[];
  stepsLoading: boolean;
}) {
  const kind = statusKindFromScenario(scenario.status);
  return (
    <li>
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
            <StepList steps={steps} />
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

  const {
    rows: runRows,
    loading: runLoading,
    error: runError,
  } = useE2eQuery<RunRow>(
    runId
      ? `SELECT run_id, run_time, status_token, failed_count, total_count, is_nightly
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
  }, [scenarios, failuresOnly, selectedTags]);

  const run = runRows[0];
  const combinedError = dataError ?? runError ?? scenariosError;

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
                  return (
                    <ScenarioRow_
                      key={key}
                      scenario={scenario}
                      isOpen={openScenario === key}
                      onToggle={() => setOpenScenario(openScenario === key ? null : key)}
                      steps={stepsByScenario.get(key) ?? []}
                      stepsLoading={stepsLoading && openScenario === key}
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
