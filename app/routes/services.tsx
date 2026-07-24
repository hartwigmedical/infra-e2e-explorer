import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { Boxes, TriangleAlert } from "lucide-react";
import { useE2eData, useE2eQuery } from "~/contexts/E2eDataContext";
import { useRunScope } from "~/contexts/RunScopeContext";
import Spinner from "~/components/Spinner";
import StatusMark from "~/components/StatusMark";
import { statusKindFromRunToken } from "~/lib/status";
import { makeIsSuspectDeploy } from "~/lib/deployments";
import { cn } from "~/lib/utils";

/** One (run, service) version cell, straight from service_versions ⋈ runs. */
interface VersionRow {
  run_id: string;
  service: string;
  spec: string | null;
  version: string | null;
  pipeline_version: string | null;
}

/** One (run, scenario) outcome — the raw material for per-run failure counts,
 *  new-failure detection, and the resolution check (see the lane build). */
interface ScenarioStatusRow {
  run_id: string;
  scenario_id: string;
  status: string;
}

/** Per-run header metadata (outcome + folder-name counts). */
interface RunMetaRow {
  run_id: string;
  status_token: string;
  failed_count: number | null;
  total_count: number | null;
}

// Layout constants. The left service-name column and the right deploys-summary
// column are fixed; the run columns share a fixed width and the timeline scrolls
// horizontally between them when they overflow. Heights are shared across the
// three columns so their rows line up. BAR_PAD insets each version bar within
// its run span, giving the gap between adjacent versions AND the breathing room
// at the timeline's start/end (rather than one big gutter at the edges).
const NAME_W = 200;
const SUMMARY_W = 108;
const COL_W = 116;
const BAR_PAD = 6;
const DATE_H = 26;
const STATUS_H = 28;
const HEADER_H = DATE_H + STATUS_H;
const LANE_H = 40;

/** All (run, service) versions in scope. Nightly filter governs which runs
 *  become columns (matches the rest of the app's run scope). */
function buildVersionsSql(nightlyOnly: boolean): string {
  return `
    SELECT sv.run_id, sv.service, sv.spec, sv.version, sv.pipeline_version
    FROM service_versions sv
    JOIN runs r USING (run_id)
    ${nightlyOnly ? "WHERE r.is_nightly" : ""}
    ORDER BY sv.run_id, sv.service`;
}

/** Every (run, scenario) outcome in scope. Failure counts, new-failure
 *  detection and the "did it resolve later" check are all derived from this
 *  client-side (see the lane build), so one query feeds all three. */
function buildScenarioStatusSql(nightlyOnly: boolean): string {
  return `
    SELECT sc.run_id, sc.scenario_id, sc.status
    FROM scenarios sc
    JOIN runs r USING (run_id)
    ${nightlyOnly ? "WHERE r.is_nightly" : ""}`;
}

function buildRunMetaSql(nightlyOnly: boolean): string {
  return `
    SELECT run_id, status_token, failed_count, total_count
    FROM runs
    ${nightlyOnly ? "WHERE is_nightly" : ""}`;
}

/** "07-18" — the month-day of a run_id, matching the scenarios grid's labels. */
function runDayLabel(runId: string): string {
  return runId.slice(5, 10);
}

/** The version label shown on a bar: the parsed version, plus the launcher's
 *  --pipeline_version where present (the number people track), falling back to
 *  the raw spec when there's no image:tag version. */
function versionLabel(row: {
  version: string | null;
  spec: string | null;
  pipeline_version: string | null;
}): string {
  const base = row.version ?? row.spec ?? "—";
  return row.pipeline_version ? `${base} · pl ${row.pipeline_version}` : base;
}

/** Outcome of a run, three-valued: a clean pass, a failure whose failures also
 *  failed last time (known), or one that introduced NEW failures (regression). */
type RunState = "success" | "known" | "new";

function runStateOf(
  meta: RunMetaRow | undefined,
  failures: number,
  newFailures: number,
): RunState {
  const failed =
    failures > 0 || statusKindFromRunToken(meta?.status_token) === "failed";
  if (newFailures > 0) return "new";
  if (failed) return "known";
  return "success";
}

/** A run-lifetime interval of a constant version for one service. */
interface Segment {
  startIdx: number;
  runCount: number;
  label: string;
  spec: string;
  tooltip: string;
  /** True when this interval began with a version CHANGE (a deployment) rather
   *  than the service's first appearance in the window. */
  isDeploy: boolean;
  /** A suspect deploy: it introduced new failures that were still NOT resolved
   *  by the end of this version's tenure (see the resolution check). */
  suspect: boolean;
}

interface ServiceLane {
  service: string;
  segments: Segment[];
  /** Total deployments (version changes) within the window. */
  deployCount: number;
  /** Deployments still suspected of a lasting regression. */
  suspectCount: number;
  /** The most recent deployment is a suspect. */
  latestDeploySuspect: boolean;
  /** Column index of the most recent deployment (for recency-first sorting). */
  lastDeployIdx: number;
  /** Version changed at least once, or the service was added/removed in-window. */
  changed: boolean;
}

export default function Services() {
  const { status, error, detailsReady, windowLabel } = useE2eData();
  const { nightlyOnly } = useRunScope();
  const [showUnchanged, setShowUnchanged] = useState(false);
  // `?run=` deep-link (from the run-detail Services panel's timeline button):
  // scroll that run's column into view and outline its date. Cleared by Escape
  // or a click outside the outlined date (see below).
  const [searchParams, setSearchParams] = useSearchParams();
  const focusRun = searchParams.get("run");
  const scrollRef = useRef<HTMLDivElement>(null);

  const clearFocus = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("run");
        return next;
      },
      { replace: true, preventScrollReset: true },
    );
  }, [setSearchParams]);

  const versionsSql = useMemo(
    () => buildVersionsSql(nightlyOnly),
    [nightlyOnly],
  );
  const scenariosSql = useMemo(
    () => buildScenarioStatusSql(nightlyOnly),
    [nightlyOnly],
  );
  const metaSql = useMemo(() => buildRunMetaSql(nightlyOnly), [nightlyOnly]);

  const { rows: versionRows, loading: versionsLoading } =
    useE2eQuery<VersionRow>(detailsReady ? versionsSql : null, [
      detailsReady,
      versionsSql,
    ]);
  const { rows: scenarioRows } = useE2eQuery<ScenarioStatusRow>(
    detailsReady ? scenariosSql : null,
    [detailsReady, scenariosSql],
  );
  const { rows: metaRows } = useE2eQuery<RunMetaRow>(
    detailsReady ? metaSql : null,
    [detailsReady, metaSql],
  );

  // Run columns: every run that has version data, oldest → newest (run_id sorts
  // lexicographically == chronologically).
  const runIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of versionRows) set.add(r.run_id);
    return Array.from(set).sort();
  }, [versionRows]);
  const runIndex = useMemo(() => {
    const m = new Map<string, number>();
    runIds.forEach((id, i) => m.set(id, i));
    return m;
  }, [runIds]);

  const focusIdx = focusRun != null ? (runIndex.get(focusRun) ?? null) : null;

  // Center the deep-linked run's column once the timeline is populated.
  useEffect(() => {
    if (focusIdx == null) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = Math.max(
      0,
      focusIdx * COL_W - (el.clientWidth - COL_W) / 2,
    );
  }, [focusIdx, runIds.length]);

  // Clear the selection on Escape or a click outside the outlined date. Both
  // listeners are attached only while a run is selected.
  useEffect(() => {
    if (focusIdx == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearFocus();
    };
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (target?.closest("[data-run-focus]")) return;
      clearFocus();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [focusIdx, clearFocus]);

  const metaByRun = useMemo(() => {
    const m = new Map<string, RunMetaRow>();
    for (const r of metaRows) m.set(r.run_id, r);
    return m;
  }, [metaRows]);

  // Scenario outcomes reshaped for two jobs:
  //  - statusByScenario[scenario][runIdx] = status, for the resolution check.
  //  - per run: total failures, and the SET of scenarios that newly failed
  //    (failed now, passed at the scenario's previous appearance).
  const { statusByScenario, failuresByIdx, newlyFailedByIdx } = useMemo(() => {
    const byScenario = new Map<string, Map<number, string>>();
    for (const r of scenarioRows) {
      const idx = runIndex.get(r.run_id);
      if (idx == null) continue;
      let m = byScenario.get(r.scenario_id);
      if (!m) {
        m = new Map();
        byScenario.set(r.scenario_id, m);
      }
      m.set(idx, r.status);
    }

    const failuresByIdx = new Map<number, number>();
    const newlyFailedByIdx = new Map<number, Set<string>>();
    for (const [sid, m] of byScenario) {
      const idxs = [...m.keys()].sort((a, b) => a - b);
      let prev: string | undefined;
      for (const idx of idxs) {
        const st = m.get(idx)!;
        if (st === "failed") {
          failuresByIdx.set(idx, (failuresByIdx.get(idx) ?? 0) + 1);
          if (prev === "passed") {
            let s = newlyFailedByIdx.get(idx);
            if (!s) {
              s = new Set();
              newlyFailedByIdx.set(idx, s);
            }
            s.add(sid);
          }
        }
        prev = st;
      }
    }
    return { statusByScenario: byScenario, failuresByIdx, newlyFailedByIdx };
  }, [scenarioRows, runIndex]);

  const failureByRun = useMemo(() => {
    const m = new Map<string, { failures: number; newFailures: number }>();
    runIds.forEach((rid, idx) => {
      m.set(rid, {
        failures: failuresByIdx.get(idx) ?? 0,
        newFailures: newlyFailedByIdx.get(idx)?.size ?? 0,
      });
    });
    return m;
  }, [runIds, failuresByIdx, newlyFailedByIdx]);

  // Build one lane per service: walk the run columns, grouping maximal runs of
  // an unchanged spec into a segment. A gap (service absent that run) breaks the
  // run; a segment starting on a spec differing from the previous column is a
  // deployment.
  const lanes = useMemo<ServiceLane[]>(() => {
    const byService = new Map<string, Map<string, VersionRow>>();
    for (const r of versionRows) {
      let m = byService.get(r.service);
      if (!m) {
        m = new Map();
        byService.set(r.service, m);
      }
      m.set(r.run_id, r);
    }

    // A deploy at [startIdx..endIdx] (the version's tenure) is a suspect when it
    // introduced new failures that were NOT resolved later while this same
    // version was still deployed (shared with the Scenarios stability view).
    const isSuspect = makeIsSuspectDeploy(statusByScenario, newlyFailedByIdx);

    const out: ServiceLane[] = [];
    for (const [service, byRun] of byService) {
      const specAt = runIds.map((id) => byRun.get(id)?.spec ?? null);
      const segments: Segment[] = [];
      let deployCount = 0;
      let suspectCount = 0;
      let lastDeployIdx = -1;
      let latestDeploySuspect = false;
      let i = 0;
      while (i < runIds.length) {
        const spec = specAt[i];
        if (spec == null) {
          i++;
          continue;
        }
        let j = i + 1;
        while (j < runIds.length && specAt[j] === spec) j++;
        const isDeploy = i > 0 && specAt[i - 1] !== spec;
        const suspect = isDeploy && isSuspect(i, j - 1);
        if (isDeploy) {
          deployCount++;
          if (suspect) suspectCount++;
          lastDeployIdx = i;
          latestDeploySuspect = suspect;
        }
        const row = byRun.get(runIds[i])!;
        const spanTip =
          j - i === 1
            ? runDayLabel(runIds[i])
            : `${runDayLabel(runIds[i])} → ${runDayLabel(runIds[j - 1])}`;
        segments.push({
          startIdx: i,
          runCount: j - i,
          label: versionLabel(row),
          spec,
          isDeploy,
          suspect,
          tooltip: `${service}\n${row.spec ?? "—"}\n${spanTip} (${j - i} run${j - i === 1 ? "" : "s"})${isDeploy ? (suspect ? "\n⚠ deployed into new failures that persisted" : "\ndeployed") : ""}`,
        });
        i = j;
      }

      const presentCount = specAt.filter((s) => s != null).length;
      const distinctSpecs = new Set(
        specAt.filter((s): s is string => s != null),
      ).size;
      const changed = distinctSpecs > 1 || presentCount < runIds.length;
      out.push({
        service,
        segments,
        deployCount,
        suspectCount,
        latestDeploySuspect,
        lastDeployIdx,
        changed,
      });
    }

    // Changed services first, most-recent deployment first (fresh deploys on
    // top), then by name; unchanged services trail alphabetically.
    return out.sort((a, b) => {
      if (a.changed !== b.changed) return a.changed ? -1 : 1;
      if (a.changed && b.changed && a.lastDeployIdx !== b.lastDeployIdx)
        return b.lastDeployIdx - a.lastDeployIdx;
      return a.service.localeCompare(b.service);
    });
  }, [versionRows, runIds, statusByScenario, newlyFailedByIdx]);

  const changedCount = useMemo(
    () => lanes.filter((l) => l.changed).length,
    [lanes],
  );
  const visibleLanes = useMemo(
    () => (showUnchanged ? lanes : lanes.filter((l) => l.changed)),
    [lanes, showUnchanged],
  );

  const trackWidth = runIds.length * COL_W;
  const bodyHeight = HEADER_H + visibleLanes.length * LANE_H;

  if (status === "error") {
    return (
      <div className="mx-auto max-w-6xl p-6">
        <p className="text-sm text-destructive">
          Failed to load service data{error ? `: ${error.message}` : "."}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="inline-flex items-center gap-2 text-lg font-semibold">
            <Boxes size={18} className="text-muted-foreground" />
            Services
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Deployed versions per run. If a run has new failures (vs. the run
            before it), a version deployed in that run becomes a suspect. If
            those failures later clear while that version is still deployed,
            that version is no longer a suspect.
          </p>
        </div>
        {changedCount < lanes.length && (
          <button
            type="button"
            onClick={() => setShowUnchanged((v) => !v)}
            className="rounded-md border px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          >
            {showUnchanged
              ? `Hide unchanged (${lanes.length - changedCount})`
              : `Show unchanged (${lanes.length - changedCount})`}
          </button>
        )}
      </div>

      {!detailsReady || (versionsLoading && versionRows.length === 0) ? (
        <div className="flex items-center gap-2 rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          <Spinner size={13} /> Loading services…
        </div>
      ) : runIds.length === 0 || visibleLanes.length === 0 ? (
        <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
          No service-version data in the loaded range.
        </div>
      ) : (
        <>
          <div className="w-fit max-w-full overflow-hidden rounded-lg border bg-card">
            <div className="flex">
              {/* Left: fixed service-name column. */}
              <div className="shrink-0 border-r" style={{ width: NAME_W }}>
                <div
                  className="flex items-end border-b bg-muted/30 px-3 pb-1.5 text-xs font-medium text-muted-foreground"
                  style={{ height: HEADER_H }}
                >
                  Service
                </div>
                {visibleLanes.map((lane) => (
                  <div
                    key={lane.service}
                    className="flex items-center border-b px-3 last:border-b-0"
                    style={{ height: LANE_H }}
                    title={lane.service}
                  >
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">
                      {lane.service}
                    </span>
                  </div>
                ))}
              </div>

              {/* Middle: horizontally-scrollable timeline. */}
              <div ref={scrollRef} className="min-w-0 flex-1 overflow-x-auto">
                <div
                  className="relative"
                  style={{ width: trackWidth, height: bodyHeight }}
                >
                  {/* New-failure column bands — behind the lanes, full height. */}
                  {runIds.map((runId, i) =>
                    (failureByRun.get(runId)?.newFailures ?? 0) > 0 ? (
                      <div
                        key={`band-${runId}`}
                        className="absolute inset-y-0 z-0 bg-red-500/[0.06]"
                        style={{ left: i * COL_W, width: COL_W }}
                      />
                    ) : null,
                  )}

                  {/* Two-row header: date over a uniform status bar, with a solid
                      bottom divider and the same shading as the side columns. */}
                  <div
                    className="relative z-10 border-b bg-muted/30"
                    style={{ height: HEADER_H }}
                  >
                    {runIds.map((runId, i) => {
                      const meta = metaByRun.get(runId);
                      const fail = failureByRun.get(runId);
                      const failures = fail?.failures ?? 0;
                      const newFailures = fail?.newFailures ?? 0;
                      const st = runStateOf(meta, failures, newFailures);
                      const label =
                        st === "new"
                          ? `failure · ${newFailures} new error${newFailures === 1 ? "" : "s"}`
                          : st === "known"
                            ? `failure · ${failures} known error${failures === 1 ? "" : "s"}`
                            : "success";
                      const isFocused = focusIdx === i;
                      return (
                        <Link
                          key={runId}
                          to={`/runs/${encodeURIComponent(runId)}`}
                          title={`${runId}\n${label}`}
                          style={{ left: i * COL_W, width: COL_W }}
                          className="group absolute top-0 flex flex-col"
                        >
                          <span
                            className="flex items-center justify-center border-b text-[11px] font-medium tabular-nums text-muted-foreground group-hover:text-foreground"
                            style={{ height: DATE_H }}
                          >
                            <span
                              {...(isFocused ? { "data-run-focus": "" } : {})}
                              className={cn(
                                "rounded-full px-2 py-0.5",
                                isFocused && "text-foreground ring-1 ring-ring",
                              )}
                            >
                              {runDayLabel(runId)}
                            </span>
                          </span>
                          <span
                            className="flex items-center justify-center"
                            style={{ height: STATUS_H }}
                          >
                            <StatusMark
                              kind={st === "success" ? "passed" : "failed"}
                              shape="square"
                              size={16}
                              title=""
                              className={
                                st === "known" ? "opacity-40" : undefined
                              }
                            />
                          </span>
                        </Link>
                      );
                    })}
                  </div>

                  {/* Service lanes with version-interval bars. */}
                  {visibleLanes.map((lane, laneIdx) => (
                    <div
                      key={lane.service}
                      className="absolute right-0 left-0 border-b last:border-b-0"
                      style={{
                        top: HEADER_H + laneIdx * LANE_H,
                        height: LANE_H,
                      }}
                    >
                      {lane.segments.map((seg) => (
                        <div
                          key={seg.startIdx}
                          title={seg.tooltip}
                          style={{
                            left: seg.startIdx * COL_W + BAR_PAD,
                            width: seg.runCount * COL_W - 2 * BAR_PAD,
                          }}
                          className={cn(
                            "absolute top-1.5 bottom-1.5 flex items-center rounded-sm border bg-muted/60 text-[11px] text-foreground/80",
                            seg.isDeploy
                              ? seg.suspect
                                ? "border-l-[3px] border-l-red-500"
                                : "border-l-[3px] border-l-sky-500"
                              : "border-border/60",
                          )}
                        >
                          {/* Sticky label: a long-held version's label pins to the
                              visible left edge as the bar scrolls under it, staying
                              readable until the bar's right edge pushes it off. */}
                          <span
                            className="sticky overflow-hidden px-2 text-ellipsis whitespace-nowrap"
                            style={{
                              left: BAR_PAD,
                              maxWidth: seg.runCount * COL_W - 2 * BAR_PAD,
                            }}
                          >
                            {seg.label}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>

              {/* Right: fixed deploys-summary column. Suspect count / total, with
                  a warning icon in a reserved right-hand slot so it sits in the
                  same spot on every row regardless of the counts. */}
              <div className="shrink-0 border-l" style={{ width: SUMMARY_W }}>
                <div
                  className="flex items-end justify-end border-b bg-muted/30 px-3 pb-1.5 text-right text-xs font-medium text-muted-foreground"
                  style={{ height: HEADER_H }}
                >
                  Deploys
                </div>
                {visibleLanes.map((lane) => (
                  <div
                    key={lane.service}
                    className="flex items-center justify-end gap-1.5 border-b px-3 last:border-b-0"
                    style={{ height: LANE_H }}
                    title={
                      lane.deployCount === 0
                        ? "No deployments in this window"
                        : `${lane.suspectCount} of ${lane.deployCount} deployment${lane.deployCount === 1 ? "" : "s"} left new failures unresolved${lane.latestDeploySuspect ? "\n⚠ the latest deployment is a suspect" : ""}`
                    }
                  >
                    <span className="text-xs tabular-nums">
                      {lane.deployCount === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <>
                          <span
                            className={cn(
                              "font-medium",
                              lane.suspectCount > 0
                                ? "text-red-600 dark:text-red-400"
                                : "text-foreground",
                            )}
                          >
                            {lane.suspectCount}
                          </span>
                          <span className="text-muted-foreground">
                            {" / "}
                            {lane.deployCount}
                          </span>
                        </>
                      )}
                    </span>
                    <span className="flex w-3.5 shrink-0 justify-center">
                      {lane.latestDeploySuspect && (
                        <TriangleAlert
                          size={12}
                          className="text-red-600 dark:text-red-400"
                        />
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Legend. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <StatusMark kind="passed" shape="square" size={12} title="" />{" "}
              Success
            </span>
            <span className="inline-flex items-center gap-1.5">
              <StatusMark
                kind="failed"
                shape="square"
                size={12}
                title=""
                className="opacity-40"
              />{" "}
              Failure · known errors
            </span>
            <span className="inline-flex items-center gap-1.5">
              <StatusMark kind="failed" shape="square" size={12} title="" />{" "}
              Failure · new errors
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-4 rounded-sm border border-l-[3px] border-l-sky-500 bg-muted/60" />
              Deployment
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-3 w-4 rounded-sm border border-l-[3px] border-l-red-500 bg-muted/60" />
              Suspect deploy (new failures persisted)
            </span>
            <span className="ml-auto tabular-nums">
              {visibleLanes.length} service
              {visibleLanes.length === 1 ? "" : "s"} · {runIds.length} run
              {runIds.length === 1 ? "" : "s"}, oldest → newest
            </span>
          </div>
        </>
      )}
    </div>
  );
}
