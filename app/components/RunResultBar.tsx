import { cn } from "~/lib/utils";

/** Diagonal cross-hatch overlaid on a segment to flag the "changed vs the
 *  previous run" portion (new failures / newly-fixed). Painted as a
 *  repeating-linear-gradient of translucent white stripes so it reads on top
 *  of both the emerald and red fills in light and dark mode. */
const HATCH: React.CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(45deg, rgba(255,255,255,0.55) 0 1.5px, transparent 1.5px 5px)",
};

/** A tiny cross-hatched colour chip that ties a legend entry back to the
 *  hatched change-region in the bar. `colorClassName` supplies the fill. */
export function HatchSwatch({
  colorClassName,
  className,
}: {
  colorClassName: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2.5 rounded-sm",
        colorClassName,
        className,
      )}
      style={HATCH}
    />
  );
}

export type BarStatus = "passed" | "failed" | "skipped";

export interface RunResultBarProps {
  passed: number;
  failed: number;
  skipped: number;
  /** Scenarios that failed this run but passed in the previous one (regressions). */
  newFailures?: number;
  /** Scenarios that passed this run but failed in the previous one (fixes). */
  newSuccesses?: number;
  /** Previous run id the comparison is against; null/undefined hides the comparison. */
  comparedToRunId?: string | null;
  /** Statuses currently active as a filter; drives which segments read as
   *  selected vs dimmed. Only meaningful together with `onToggleStatus`. */
  selectedStatuses?: readonly string[];
  /** When provided, segments become buttons that toggle their status filter. */
  onToggleStatus?: (status: BarStatus) => void;
  className?: string;
}

interface Segment {
  key: string;
  status: BarStatus;
  count: number;
  className: string;
  hatched: boolean;
  label: string;
}

/**
 * Horizontal pass/fail/skip ratio bar for a run. Three segments sized by count
 * (passed → failed → skipped). When a previous-run comparison is supplied, the
 * inner edges where passed meets failed are cross-hatched: the tail of the
 * green segment marks newly-fixed scenarios and the head of the red segment
 * marks new failures, so regressions and recoveries sit face-to-face in the
 * middle of the bar.
 */
export default function RunResultBar({
  passed,
  failed,
  skipped,
  newFailures = 0,
  newSuccesses = 0,
  comparedToRunId,
  selectedStatuses = [],
  onToggleStatus,
  className,
}: RunResultBarProps) {
  const total = passed + failed + skipped;
  if (total === 0) return null;

  const interactive = onToggleStatus != null;
  const hasFilter = selectedStatuses.length > 0;

  const hasComparison = comparedToRunId != null;
  // Clamp change counts to their host segment so a hatched sub-segment can
  // never exceed (and thus mis-size) the solid part it's carved out of.
  const fixed = hasComparison ? Math.min(Math.max(newSuccesses, 0), passed) : 0;
  const regressed = hasComparison
    ? Math.min(Math.max(newFailures, 0), failed)
    : 0;

  // Left → right: solid passed, hatched fixed, hatched new-failures, solid
  // failed, skipped. The two hatched slices meet in the middle of the bar.
  const segments: Segment[] = [
    {
      key: "passed",
      status: "passed",
      count: passed - fixed,
      className: "bg-emerald-500",
      hatched: false,
      label: `${passed} passed`,
    },
    {
      key: "fixed",
      status: "passed",
      count: fixed,
      className: "bg-emerald-500",
      hatched: true,
      label: `${fixed} newly fixed (failed → passed vs previous run)`,
    },
    {
      key: "new-failed",
      status: "failed",
      count: regressed,
      className: "bg-red-500",
      hatched: true,
      label: `${regressed} new failure${regressed === 1 ? "" : "s"} (passed → failed vs previous run)`,
    },
    {
      key: "failed",
      status: "failed",
      count: failed - regressed,
      className: "bg-red-500",
      hatched: false,
      label: `${failed} failed`,
    },
    {
      key: "skipped",
      status: "skipped",
      count: skipped,
      className: "bg-amber-500",
      hatched: false,
      label: `${skipped} skipped`,
    },
  ];

  const summary =
    `${passed} passed · ${failed} failed · ${skipped} skipped` +
    (hasComparison
      ? ` — vs ${comparedToRunId}: ${regressed} new failure${regressed === 1 ? "" : "s"}, ${fixed} fixed`
      : "");

  return (
    <div
      role={interactive ? "group" : "img"}
      aria-label={summary}
      title={summary}
      className={cn(
        "flex h-3.5 w-full overflow-hidden rounded-full bg-muted",
        className,
      )}
    >
      {segments
        .filter((s) => s.count > 0)
        .map((s) => {
          const dimmed = hasFilter && !selectedStatuses.includes(s.status);
          const style = {
            width: `${(s.count / total) * 100}%`,
            ...(s.hatched ? HATCH : null),
          };
          const fill = cn(
            "h-full transition-opacity",
            s.className,
            dimmed && "opacity-40",
          );
          return interactive ? (
            <button
              key={s.key}
              type="button"
              onClick={() => onToggleStatus!(s.status)}
              aria-pressed={selectedStatuses.includes(s.status)}
              className={cn(fill, "cursor-pointer")}
              style={style}
              title={`${s.label} — click to filter`}
            />
          ) : (
            <div key={s.key} className={fill} style={style} title={s.label} />
          );
        })}
    </div>
  );
}
