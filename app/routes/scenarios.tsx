import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Search } from "lucide-react";
import { useE2eData, useE2eQuery } from "~/contexts/E2eDataContext";
import Spinner from "~/components/Spinner";
import StatusMark from "~/components/StatusMark";
import TagFilter from "~/components/TagFilter";
import { statusKindFromScenario, statusLabel, type StatusKind } from "~/lib/status";
import { cn } from "~/lib/utils";

interface MasterRow {
  feature_uri: string;
  feature_name: string;
  scenario_id: string;
  scenario_name: string;
  latest_status: string;
  tag_names: string[] | null;
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
  has_error: boolean;
  error_message: string | null;
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
 * match - independent of the master list's nightly/search/feature/tag
 * filters, so a deep link stays resolvable even when those filters would hide
 * the row from the left-hand list.
 */
interface ScenarioIdentityRow {
  feature_uri: string;
  feature_name: string;
  scenario_id: string;
  scenario_name: string;
  tag_names: string[] | null;
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

function buildMasterSql(nightlyOnly: boolean): string {
  return `
    WITH filtered AS (
      SELECT s.feature_uri, s.feature_name, s.scenario_id, s.scenario_name, s.status, s.run_id, s.tag_names
      FROM scenarios s
      JOIN runs r USING (run_id)
      ${nightlyOnly ? "WHERE r.is_nightly" : ""}
    ),
    ranked AS (
      SELECT *, row_number() OVER (PARTITION BY feature_uri, scenario_id ORDER BY run_id DESC) AS rn
      FROM filtered
    )
    SELECT feature_uri, feature_name, scenario_id, scenario_name, status AS latest_status, tag_names
    FROM ranked WHERE rn = 1
    ORDER BY feature_name, scenario_name
  `;
}

function buildHistorySql(featureUri: string, scenarioId: string, nightlyOnly: boolean): string {
  return `
    SELECT s.run_id, s.status, s.duration_s, r.is_nightly
    FROM scenarios s
    JOIN runs r USING (run_id)
    WHERE s.feature_uri = ${sqlLit(featureUri)} AND s.scenario_id = ${sqlLit(scenarioId)}
    ${nightlyOnly ? "AND r.is_nightly" : ""}
    ORDER BY s.run_id
  `;
}

function buildStepHistorySql(featureUri: string, scenarioId: string, nightlyOnly: boolean): string {
  return `
    SELECT st.run_id, st.step_ordinal, st.step_label, st.status, st.has_error, st.error_message
    FROM steps st
    JOIN runs r USING (run_id)
    WHERE st.feature_uri = ${sqlLit(featureUri)} AND st.scenario_id = ${sqlLit(scenarioId)}
    ${nightlyOnly ? "AND r.is_nightly" : ""}
    ORDER BY st.run_id, st.step_ordinal
  `;
}

/**
 * Resolve a scenario's display name/tags by exact (feature_uri, scenario_id)
 * match, with no join against `runs` at all - so it's unaffected by the
 * "nightly only" toggle (or any other master-list filter). This is what lets
 * a deep link keep showing its scenario even when the current filters would
 * exclude that row from the left-hand list.
 */
function buildScenarioIdentitySql(featureUri: string, scenarioId: string): string {
  return `
    SELECT feature_uri, feature_name, scenario_id, scenario_name, tag_names
    FROM scenarios
    WHERE feature_uri = ${sqlLit(featureUri)} AND scenario_id = ${sqlLit(scenarioId)}
    LIMIT 1
  `;
}

function formatRunDateTime(runId: string): string {
  const date = runId.slice(0, 10);
  const time = runId.slice(11, 15);
  return /^\d{4}$/.test(time) ? `${date} ${time.slice(0, 2)}:${time.slice(2, 4)}` : date;
}

function formatDuration(durationS: number | null | undefined): string {
  if (durationS == null) return "—";
  if (durationS < 60) return `${durationS.toFixed(1)}s`;
  const totalSeconds = Math.round(durationS);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m${String(seconds).padStart(2, "0")}s`;
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
          <StatusMark kind={item.kind} shape="square" size={14} title={item.label} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function TagChips({ tags, className }: { tags: string[] | null | undefined; className?: string }) {
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

function HistoryStrip({
  rows,
  scenarioId,
  hoveredRunId,
  onHoverRun,
}: {
  rows: HistoryRow[];
  scenarioId: string;
  hoveredRunId: string | null;
  onHoverRun: (runId: string | null) => void;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No runs match the current filter.</p>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {rows.map((row) => {
        const kind = statusKindFromScenario(row.status);
        return (
          <Link
            key={row.run_id}
            to={`/runs/${encodeURIComponent(row.run_id)}?scenario=${encodeURIComponent(scenarioId)}`}
            onMouseEnter={() => onHoverRun(row.run_id)}
            onMouseLeave={() => onHoverRun(null)}
            title={`${row.run_id}\n${formatRunDateTime(row.run_id)}\n${statusLabel(kind)} · ${formatDuration(row.duration_s)}${row.is_nightly ? "" : " · manual"}`}
            className={cn(
              "transition-transform hover:scale-125",
              hoveredRunId === row.run_id && "ring-2 ring-ring"
            )}
          >
            <StatusMark kind={kind} shape="square" size={16} title="" />
          </Link>
        );
      })}
    </div>
  );
}

interface StepGridRow {
  step_ordinal: number;
  step_label: string;
  cells: Map<string, StepHistoryRow>;
}

function StepGrid({
  runIds,
  stepRows,
  scenarioId,
  hoveredRunId,
  onHoverRun,
}: {
  runIds: string[];
  stepRows: StepHistoryRow[];
  scenarioId: string;
  hoveredRunId: string | null;
  onHoverRun: (runId: string | null) => void;
}) {
  const gridRows = useMemo<StepGridRow[]>(() => {
    const byOrdinal = new Map<number, StepGridRow>();
    for (const row of stepRows) {
      let entry = byOrdinal.get(row.step_ordinal);
      if (!entry) {
        entry = { step_ordinal: row.step_ordinal, step_label: row.step_label, cells: new Map() };
        byOrdinal.set(row.step_ordinal, entry);
      }
      // stepRows is ordered by run_id ascending, so the last write wins -
      // i.e. the label reflects the most recent run that had this step.
      entry.step_label = row.step_label;
      entry.cells.set(row.run_id, row);
    }
    return Array.from(byOrdinal.values()).sort((a, b) => a.step_ordinal - b.step_ordinal);
  }, [stepRows]);

  if (gridRows.length === 0) {
    return <p className="text-sm text-muted-foreground">No step data for this scenario.</p>;
  }

  return (
    <div className="max-h-[60vh] overflow-x-auto overflow-y-auto rounded-lg border">
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr>
            <th className="sticky top-0 left-0 z-30 min-w-[240px] max-w-[320px] border-b bg-muted px-2 py-1.5 text-left font-medium text-muted-foreground">
              Step
            </th>
            {runIds.map((runId) => (
              <th
                key={runId}
                title={runId}
                onMouseEnter={() => onHoverRun(runId)}
                onMouseLeave={() => onHoverRun(null)}
                className={cn(
                  "sticky top-0 z-10 w-6 border-b bg-muted px-0.5 py-1.5 text-center font-normal text-muted-foreground",
                  hoveredRunId === runId && "bg-accent"
                )}
              >
                <span
                  className="inline-block whitespace-nowrap text-[10px]"
                  style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
                >
                  {runId.slice(5, 10)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {gridRows.map((row) => (
            <tr key={row.step_ordinal}>
              <td
                className="sticky left-0 z-20 max-w-[320px] truncate border-b bg-card px-2 py-1"
                title={row.step_label}
              >
                {row.step_label}
              </td>
              {runIds.map((runId) => {
                const cell = row.cells.get(runId);
                const kind = cell ? statusKindFromScenario(cell.status) : "unknown";
                const isHoveredCol = hoveredRunId === runId;
                const label = cell ? statusLabel(kind) : "no data";
                return (
                  <td
                    key={runId}
                    className={cn("border-b p-0.5 text-center", isHoveredCol && "bg-accent")}
                  >
                    <Link
                      to={`/runs/${encodeURIComponent(runId)}?scenario=${encodeURIComponent(scenarioId)}&step=${row.step_ordinal}`}
                      onMouseEnter={() => onHoverRun(runId)}
                      onMouseLeave={() => onHoverRun(null)}
                      title={`${row.step_label} · ${runId} · ${label} — open run detail`}
                      className="mx-auto block transition-transform hover:scale-125"
                    >
                      <StatusMark kind={kind} shape="square" size={16} title="" />
                    </Link>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ScenarioDetailPanel({
  selected,
  nightlyOnly,
  tags,
  hoveredRunId,
  onHoverRun,
}: {
  selected: SelectedScenario;
  nightlyOnly: boolean;
  tags: string[];
  hoveredRunId: string | null;
  onHoverRun: (runId: string | null) => void;
}) {
  const { detailsReady } = useE2eData();

  const { rows: historyRows, loading: historyLoading } = useE2eQuery<HistoryRow>(
    detailsReady ? buildHistorySql(selected.feature_uri, selected.scenario_id, nightlyOnly) : null,
    [detailsReady, selected.feature_uri, selected.scenario_id, nightlyOnly]
  );

  const { rows: stepRows, loading: stepsLoading } = useE2eQuery<StepHistoryRow>(
    detailsReady ? buildStepHistorySql(selected.feature_uri, selected.scenario_id, nightlyOnly) : null,
    [detailsReady, selected.feature_uri, selected.scenario_id, nightlyOnly]
  );

  const runIds = useMemo(() => historyRows.map((r) => r.run_id), [historyRows]);

  const passRate = useMemo(() => {
    if (historyRows.length === 0) return null;
    const passed = historyRows.filter((r) => r.status === "passed").length;
    return passed / historyRows.length;
  }, [historyRows]);

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
        </div>
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-muted-foreground">History (oldest → newest)</h3>
          <Legend />
        </div>
        {historyLoading && historyRows.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size={13} /> Loading history…
          </div>
        ) : (
          <HistoryStrip
            rows={historyRows}
            scenarioId={selected.scenario_id}
            hoveredRunId={hoveredRunId}
            onHoverRun={onHoverRun}
          />
        )}
      </div>

      <div className="rounded-lg border bg-card p-4">
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
          Step history ({runIds.length} run{runIds.length === 1 ? "" : "s"})
        </h3>
        {stepsLoading && stepRows.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size={13} /> Loading step history…
          </div>
        ) : (
          <StepGrid
            runIds={runIds}
            stepRows={stepRows}
            scenarioId={selected.scenario_id}
            hoveredRunId={hoveredRunId}
            onHoverRun={onHoverRun}
          />
        )}
      </div>
    </div>
  );
}

export default function Scenarios() {
  const { status, error, detailsReady } = useE2eData();
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [nightlyOnly, setNightlyOnly] = useState(true);
  const [featureFilter, setFeatureFilter] = useState("");
  const [selectedTags, setSelectedTags] = useState<Set<string>>(new Set());
  const [hoveredRunId, setHoveredRunId] = useState<string | null>(null);
  const selectedItemRef = useRef<HTMLButtonElement | null>(null);

  // The URL is the single source of truth for the selection: `selected` below
  // is derived (never stored in React state) from `?feature=&scenario=`, by
  // exact (feature_uri, scenario_id) match. This effect-free derivation is
  // what makes it stable - there's no mount-time or stale-closure effect that
  // could resolve to, or overwrite the URL with, a different scenario. The
  // ONLY thing that ever writes to the URL is the list item's onClick
  // (selectScenario, below).
  const decodedFeatureUri = safeDecodeURIComponent(searchParams.get("feature"));
  const decodedScenarioId = safeDecodeURIComponent(searchParams.get("scenario"));
  const wantsSelection = decodedFeatureUri !== null && decodedScenarioId !== null;

  const masterSql = useMemo(() => buildMasterSql(nightlyOnly), [nightlyOnly]);
  const {
    rows: masterRows,
    loading: masterLoading,
    error: masterError,
  } = useE2eQuery<MasterRow>(detailsReady ? masterSql : null, [detailsReady, masterSql]);

  // Resolved independently of the master list's nightly/search/feature/tag
  // filters (no join against `runs`), so a deep-linked scenario stays
  // selected/shown even when those filters would hide it from the left list.
  const identitySql = useMemo(() => {
    if (!decodedFeatureUri || !decodedScenarioId) return null;
    return buildScenarioIdentitySql(decodedFeatureUri, decodedScenarioId);
  }, [decodedFeatureUri, decodedScenarioId]);
  const { rows: identityRows, loading: identityLoading } = useE2eQuery<ScenarioIdentityRow>(
    detailsReady ? identitySql : null,
    [detailsReady, identitySql]
  );

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

  const selectedTagsList = useMemo(() => toTagArray(identityRows[0]?.tag_names), [identityRows]);

  // True while a URL-driven selection hasn't resolved yet (still waiting on
  // detailsReady / the identity query) - lets the UI show a loading state
  // instead of momentarily flashing "Select a scenario" or, worse, resolving
  // to nothing while data is still on the way.
  const resolvingSelection = wantsSelection && !selected && (!detailsReady || identityLoading);

  // Scroll the selected row into view whenever the selection changes other
  // than by clicking a currently-visible row (deep link on load, URL param
  // change, browser back/forward, or once the list finishes loading). Re-runs
  // when masterRows arrives in case the row wasn't rendered yet when the
  // selection first resolved. `block: "nearest"` is a no-op if it's already
  // on-screen, so this never jars a plain click.
  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: "nearest" });
  }, [selected?.feature_uri, selected?.scenario_id, masterRows]);

  // The only place that writes to the URL - a plain push (default), not
  // replace, so the browser Back button steps back through previously
  // selected scenarios instead of skipping over them.
  const selectScenario = (sc: MasterRow) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("feature", sc.feature_uri);
      next.set("scenario", sc.scenario_id);
      return next;
    });
  };

  const featureOptions = useMemo(() => {
    const names = new Set(masterRows.map((r) => r.feature_name));
    return Array.from(names).sort();
  }, [masterRows]);

  const tagOptions = useMemo(() => {
    const names = new Set<string>();
    for (const r of masterRows) {
      for (const tag of toTagArray(r.tag_names)) names.add(tag);
    }
    return Array.from(names).sort();
  }, [masterRows]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return masterRows.filter((r) => {
      if (featureFilter && r.feature_name !== featureFilter) return false;
      if (q && !r.scenario_name.toLowerCase().includes(q)) return false;
      if (selectedTags.size > 0) {
        const rowTags = toTagArray(r.tag_names);
        if (!rowTags.some((t) => selectedTags.has(t))) return false;
      }
      return true;
    });
  }, [masterRows, search, featureFilter, selectedTags]);

  const groupedMaster = useMemo(() => {
    const groups: { feature_name: string; scenarios: MasterRow[] }[] = [];
    let current: { feature_name: string; scenarios: MasterRow[] } | null = null;
    for (const row of filteredRows) {
      if (!current || current.feature_name !== row.feature_name) {
        current = { feature_name: row.feature_name, scenarios: [] };
        groups.push(current);
      }
      current.scenarios.push(row);
    }
    return groups;
  }, [filteredRows]);

  if (status === "error" || masterError) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 p-6">
        <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to Recent Runs
        </Link>
        <p className="text-sm text-destructive">
          Failed to load scenario data{(error ?? masterError) ? `: ${(error ?? masterError)!.message}` : "."}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <Link to="/" className="text-sm text-muted-foreground hover:text-foreground">
        ← Back to Recent Runs
      </Link>

      <h1 className="text-lg font-semibold">Scenario history</h1>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3">
        <div className="relative min-w-[200px] flex-1">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            name="scenario-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search scenarios…"
            className="w-full rounded border bg-background px-2 py-1.5 pl-7 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <select
          name="feature-filter"
          value={featureFilter}
          onChange={(e) => setFeatureFilter(e.target.value)}
          className="rounded border bg-background px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-ring"
        >
          <option value="">All features</option>
          {featureOptions.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm whitespace-nowrap">
          <input
            type="checkbox"
            name="nightly-only"
            checked={nightlyOnly}
            onChange={(e) => setNightlyOnly(e.target.checked)}
            className="size-3.5 accent-sky-500"
          />
          Nightly runs only
        </label>
        <TagFilter
          allTags={tagOptions}
          selected={Array.from(selectedTags)}
          onChange={(next) => setSelectedTags(new Set(next))}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_1fr]">
        <div className="max-h-[75vh] overflow-y-auto rounded-lg border bg-card">
          {!detailsReady ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Spinner size={13} /> Loading scenario details…
            </div>
          ) : masterLoading && masterRows.length === 0 ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Spinner size={13} /> Loading scenarios…
            </div>
          ) : groupedMaster.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No scenarios match.</p>
          ) : (
            groupedMaster.map((group) => (
              <div key={group.feature_name}>
                <div className="sticky top-0 bg-muted/70 px-3 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur-sm">
                  {group.feature_name}
                </div>
                <ul>
                  {group.scenarios.map((sc) => {
                    const isSelected =
                      selected?.feature_uri === sc.feature_uri && selected?.scenario_id === sc.scenario_id;
                    const kind = statusKindFromScenario(sc.latest_status);
                    return (
                      <li key={`${sc.feature_uri}::${sc.scenario_id}`}>
                        <button
                          type="button"
                          ref={isSelected ? selectedItemRef : undefined}
                          onClick={() => selectScenario(sc)}
                          className={cn(
                            "flex w-full items-center gap-2 border-l-2 px-3 py-1.5 text-left text-sm transition-colors",
                            isSelected
                              ? "border-primary bg-accent font-medium text-accent-foreground"
                              : "border-transparent hover:bg-muted/50"
                          )}
                        >
                          <StatusMark kind={kind} shape="dot" size={8} />
                          <span className="flex-1 truncate">{sc.scenario_name}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </div>

        <div className="min-w-0">
          {selected ? (
            <ScenarioDetailPanel
              selected={selected}
              nightlyOnly={nightlyOnly}
              tags={selectedTagsList}
              hoveredRunId={hoveredRunId}
              onHoverRun={setHoveredRunId}
            />
          ) : resolvingSelection ? (
            <div className="flex h-64 items-center justify-center gap-2 rounded-lg border bg-card text-sm text-muted-foreground">
              <Spinner size={13} /> Loading scenario…
            </div>
          ) : wantsSelection ? (
            <div className="flex h-64 items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground">
              Scenario not found.
            </div>
          ) : (
            <div className="flex h-64 items-center justify-center rounded-lg border bg-card text-sm text-muted-foreground">
              Select a scenario to view its history.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
