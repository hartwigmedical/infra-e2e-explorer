import { useMemo } from "react";
import {
  statusKindFromScenario,
  statusDotClass,
  statusLabel,
  type StatusKind,
} from "~/lib/status";
import { cn } from "~/lib/utils";

/**
 * A scenario as the Gantt needs it. `started_ms` is epoch milliseconds
 * (SELECT `epoch_ms(started_at)::DOUBLE` - cast to DOUBLE so it arrives as a
 * plain JS number, not an Arrow int64/BigInt). `duration_s` is the scenario's
 * busy time (Σ step durations) in seconds - see the note on wall-clock below.
 */
export interface GanttScenario {
  scenario_id: string;
  feature_uri: string;
  scenario_name: string;
  status: string;
  started_ms: number | null;
  duration_s: number | null;
}

interface PlacedScenario extends GanttScenario {
  lane: number;
  /** ms offset of this bar's start from the run's first scenario start. */
  startOffMs: number;
  /** bar length in ms (duration_s * 1000). */
  durMs: number;
  isLongPole: boolean;
}

/** A scenario with the numeric start/duration the timeline needs to place it. */
type PlaceableScenario = GanttScenario & {
  started_ms: number;
  duration_s: number;
};

/** Scenarios that can actually be positioned on the timeline (finite start +
 *  duration). Shared by `computeRunTiming` (the collapsed header summary) and
 *  `packLanes` (the full render) so both agree on what counts. */
function getPlaceable(scenarios: GanttScenario[]): PlaceableScenario[] {
  return scenarios.filter(
    (s): s is PlaceableScenario =>
      typeof s.started_ms === "number" &&
      Number.isFinite(s.started_ms) &&
      typeof s.duration_s === "number" &&
      Number.isFinite(s.duration_s),
  );
}

export interface RunTiming {
  /** Wall-clock span from the first scenario start to the last scenario end. */
  makespanMs: number;
  /** Total busy time (Σ scenario durations); exceeds makespan under parallelism. */
  busyMs: number;
  /** busy ÷ makespan - average number of scenarios running at once. */
  avgParallelism: number;
}

/**
 * Cheap wall-clock + busy summary (no lane packing) for the collapsed header
 * toggle. Returns null when there's nothing meaningful to show - fewer than
 * two placeable scenarios or a degenerate makespan - the same condition under
 * which the full RunGantt renders nothing.
 */
export function computeRunTiming(scenarios: GanttScenario[]): RunTiming | null {
  const placeable = getPlaceable(scenarios);
  if (placeable.length < 2) return null;
  const t0 = Math.min(...placeable.map((s) => s.started_ms));
  const tN = Math.max(
    ...placeable.map((s) => s.started_ms + s.duration_s * 1000),
  );
  const makespanMs = tN - t0;
  if (makespanMs <= 0) return null;
  const busyMs = placeable.reduce((sum, s) => sum + s.duration_s * 1000, 0);
  return { makespanMs, busyMs, avgParallelism: busyMs / makespanMs };
}

/** "0s" / "45s" / "12m" / "1h05m" - compact elapsed formatting for the axis + tooltips. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** "1.2s" (< 60s) or "12m" / "1h05m" - a bar's own length, for tooltips. */
function formatDuration(durationS: number): string {
  if (durationS < 60) return `${durationS.toFixed(1)}s`;
  return formatElapsed(durationS * 1000);
}

/** Solid bar fill per status (reuses the shared status colour vocabulary). */
function barClass(kind: StatusKind): string {
  return statusDotClass(kind);
}

/**
 * Greedy interval-partitioning: assign each scenario (sorted by start) to the
 * first lane whose previous bar has already ended, else open a new lane. This
 * is exactly what a fixed-size thread pool does - the first free worker picks
 * up the next scenario - so the number of lanes this yields equals the run's
 * PEAK concurrency, i.e. how many scenarios were ever in flight at once. For
 * the nightly suite that's the configured `--threads 8`, so a saturated run
 * fills 8 lanes; the tail (only the long pole still running) is the visible
 * gap between that peak and the ~5x AVERAGE parallelism.
 */
function packLanes(scenarios: GanttScenario[]): {
  placed: PlacedScenario[];
  laneCount: number;
  makespanMs: number;
  busyMs: number;
  excluded: number;
} {
  const placeable = getPlaceable(scenarios);
  const excluded = scenarios.length - placeable.length;

  if (placeable.length === 0) {
    return { placed: [], laneCount: 0, makespanMs: 0, busyMs: 0, excluded };
  }

  const t0 = Math.min(...placeable.map((s) => s.started_ms));
  const tN = Math.max(
    ...placeable.map((s) => s.started_ms + s.duration_s * 1000),
  );
  const makespanMs = Math.max(0, tN - t0);
  const busyMs = placeable.reduce((sum, s) => sum + s.duration_s * 1000, 0);
  const maxDurMs = Math.max(...placeable.map((s) => s.duration_s * 1000));

  // Sort by start (tie-break longer-first, cosmetic only). Lane count is
  // invariant to the tie-break; it always equals peak concurrency.
  const sorted = [...placeable].sort(
    (a, b) => a.started_ms - b.started_ms || b.duration_s - a.duration_s,
  );

  const laneEnds: number[] = [];
  const placed: PlacedScenario[] = sorted.map((s) => {
    const start = s.started_ms;
    const end = start + s.duration_s * 1000;
    let lane = laneEnds.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(end);
    } else {
      laneEnds[lane] = end;
    }
    return {
      ...s,
      lane,
      startOffMs: start - t0,
      durMs: s.duration_s * 1000,
      // Only the single longest bar is flagged - the critical path / long pole.
      isLongPole: s.duration_s * 1000 === maxDurMs,
    };
  });

  return { placed, laneCount: laneEnds.length, makespanMs, busyMs, excluded };
}

/**
 * A lane-packed execution timeline for one run: scenarios laid out on a shared
 * relative time axis and packed into as many lanes as the run's peak
 * concurrency, so the parallel structure (and the long-pole tail) is visible
 * at a glance. Bars are positioned by each scenario's `started_at`; a bar's
 * length is its busy time (Σ step durations) - a good proxy for wall-clock
 * within a single scenario, since its steps run sequentially.
 *
 * Renders as a bare (chrome-less) region meant to be dropped into an
 * expandable container directly under the run header's timing summary (which
 * already shows wall-clock + parallelism); it therefore has no card frame or
 * heading of its own, and surfaces only the complementary lanes/busy stats in
 * its footer. Renders nothing when fewer than two scenarios can be placed
 * (nothing to compare) or the makespan is degenerate. Uses only the
 * `scenarios` table, so it works even in the steps-table OOM fallback.
 */
export default function RunGantt({
  scenarios,
  focusedScenarioId,
  onSelectScenario,
}: {
  scenarios: GanttScenario[];
  focusedScenarioId?: string | null;
  onSelectScenario?: (scenarioId: string) => void;
}) {
  const { placed, laneCount, makespanMs, busyMs, excluded } = useMemo(
    () => packLanes(scenarios),
    [scenarios],
  );

  if (placed.length < 2 || makespanMs <= 0) return null;

  // ~5 evenly spaced axis ticks (0% .. 100%), labelled with elapsed time.
  const TICKS = 5;
  const ticks = Array.from({ length: TICKS }, (_, i) => {
    const frac = i / (TICKS - 1);
    return { frac, label: formatElapsed(makespanMs * frac) };
  });

  const lanes = Array.from({ length: laneCount }, (_, i) => i);

  return (
    <div>
      {/* Time axis */}
      <div className="relative mb-1 ml-6 h-4 select-none">
        {ticks.map((tick, i) => (
          <span
            key={i}
            className={cn(
              "absolute top-0 -translate-x-1/2 font-mono text-[10px] text-muted-foreground",
              i === 0 && "translate-x-0",
              i === ticks.length - 1 && "-translate-x-full",
            )}
            style={{ left: `${tick.frac * 100}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>

      {/* Lanes */}
      <div className="space-y-1.5">
        {lanes.map((lane) => (
          <div key={lane} className="flex items-center gap-1">
            <span className="w-5 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
              {lane + 1}
            </span>
            <div className="relative h-5 flex-1 rounded bg-muted/40">
              {placed
                .filter((p) => p.lane === lane)
                .map((p) => {
                  const kind = statusKindFromScenario(p.status);
                  const leftPct = (p.startOffMs / makespanMs) * 100;
                  const widthPct = (p.durMs / makespanMs) * 100;
                  const isFocused = focusedScenarioId === p.scenario_id;
                  return (
                    <button
                      key={`${p.feature_uri}::${p.scenario_id}`}
                      type="button"
                      onClick={() => onSelectScenario?.(p.scenario_id)}
                      title={`${p.scenario_name}\n${statusLabel(kind)} · ${formatDuration(p.duration_s ?? 0)} · starts +${formatElapsed(p.startOffMs)}${p.isLongPole ? "\nLong pole (critical path)" : ""}`}
                      style={{
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                        minWidth: 3,
                      }}
                      className={cn(
                        "absolute top-0 flex h-5 items-center overflow-hidden rounded px-1 text-left text-[10px] whitespace-nowrap text-white/95 transition-[filter] hover:brightness-110",
                        barClass(kind),
                        p.isLongPole && "ring-1 ring-foreground/40",
                        isFocused &&
                          "outline outline-2 outline-offset-1 outline-ring",
                      )}
                    >
                      {p.scenario_name}
                    </button>
                  );
                })}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        {(["passed", "failed", "skipped"] as StatusKind[]).map((kind) => (
          <span key={kind} className="inline-flex items-center gap-1.5">
            <span
              className={cn(
                "inline-block size-2.5 rounded-[3px]",
                barClass(kind),
              )}
            />
            {statusLabel(kind)}
          </span>
        ))}
        <span className="ml-auto tabular-nums">
          {laneCount} lanes · {formatElapsed(busyMs)} busy ·{" "}
          {(busyMs / makespanMs).toFixed(1)}× parallel
          {excluded > 0 && ` · ${excluded} not shown`}
        </span>
      </div>
    </div>
  );
}
