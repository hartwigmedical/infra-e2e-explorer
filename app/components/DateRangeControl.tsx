import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarRange, ChevronDown } from "lucide-react";
import { eachDayOfInterval, format } from "date-fns";
import { useE2eData, useE2eQuery } from "~/contexts/E2eDataContext";
import Spinner from "~/components/Spinner";
import Sparkline from "~/components/Sparkline";
import { cn } from "~/lib/utils";

interface OldestNewestRow {
  oldest: string | null;
  newest: string | null;
}

interface DailyCountRow {
  day: string;
  n: number;
}

const RANGE_SQL =
  "SELECT min(run_id) AS oldest, max(run_id) AS newest FROM runs";

const DAILY_COUNTS_SQL =
  "SELECT substr(run_id,1,10) AS day, count(*) AS n FROM runs GROUP BY 1 ORDER BY 1";

/** Parse a "YYYY-MM-DD" string into a local-midnight Date via its y/m/d parts
 *  (NOT `new Date(str)`, which parses as UTC midnight) - so that formatting
 *  it back (also local-time based, via date-fns) always recovers the same
 *  calendar day regardless of the viewer's timezone offset. Returns null for
 *  anything that doesn't look like a date. */
function parseYMD(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "YYYY-MM-DD" for a local-midnight Date, matching the keys produced by
 *  DAILY_COUNTS_SQL's `substr(run_id,1,10)`. */
function toDayKey(date: Date): string {
  return format(date, "yyyy-MM-dd");
}

/** Human-friendly range label, e.g. "Jul 3 – Jul 9, 2026", collapsing to a
 *  single date when oldest === newest. Returns "No data loaded" when either
 *  end is missing. */
function formatRange(oldest: Date | null, newest: Date | null): string {
  if (!oldest || !newest) return "No data loaded";
  if (toDayKey(oldest) === toDayKey(newest)) {
    return format(newest, "MMM d, yyyy");
  }
  if (oldest.getFullYear() === newest.getFullYear()) {
    return `${format(oldest, "MMM d")} – ${format(newest, "MMM d, yyyy")}`;
  }
  return `${format(oldest, "MMM d, yyyy")} – ${format(newest, "MMM d, yyyy")}`;
}

/**
 * Shared date-range control, shown top-right on both the dashboard and the
 * Scenarios page. The button shows the current rolling-window preset label
 * (e.g. "Last 7 days" - see WINDOW_STEPS in E2eDataContext); clicking it
 * opens a popover with the actual loaded date range, a runs/day sparkline,
 * and a "Load more" button that widens the window (soft refresh - see
 * useE2eData().loadMore).
 *
 * Dependency-free popover, same pattern as TagFilter: a relatively-positioned
 * wrapper, an absolutely-positioned panel below it, closed on click-outside
 * or Escape.
 */
export default function DateRangeControl() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const { windowLabel, nextWindowLabel, hasMore, loadingMore, loadMore, runCount } =
    useE2eData();

  const { rows: rangeRows } = useE2eQuery<OldestNewestRow>(RANGE_SQL, []);
  const { rows: dailyRows } = useE2eQuery<DailyCountRow>(DAILY_COUNTS_SQL, []);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const oldest = parseYMD(rangeRows[0]?.oldest);
  const newest = parseYMD(rangeRows[0]?.newest);
  const rangeLabel = formatRange(oldest, newest);

  // Gap-fill: enumerate every calendar day from oldest -> newest loaded day
  // and map to that day's run count (0 where there's no run), so the
  // sparkline reflects true daily density instead of silently skipping gaps.
  const dailyValues = useMemo(() => {
    if (!oldest || !newest) return [];
    const countByDay = new Map(dailyRows.map((r) => [r.day, r.n]));
    const days = eachDayOfInterval({ start: oldest, end: newest });
    return days.map((d) => countByDay.get(toDayKey(d)) ?? 0);
  }, [oldest, newest, dailyRows]);

  const canLoadMore = hasMore && nextWindowLabel != null;

  return (
    <div ref={ref} className={cn("relative")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground",
          open && "border-primary/40 bg-accent"
        )}
      >
        <CalendarRange className="size-4 opacity-70" />
        <span className="font-medium">{windowLabel}</span>
        <ChevronDown className="size-3.5 opacity-60" />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-72 space-y-3 rounded-md border bg-popover p-3 text-popover-foreground shadow-md">
          <div>
            <div className="text-xs text-muted-foreground">Loaded date range</div>
            <div className="mt-0.5 flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium">{rangeLabel}</span>
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                {runCount} run{runCount === 1 ? "" : "s"}
              </span>
            </div>
          </div>

          <div>
            <div className="mb-1 text-xs text-muted-foreground">Runs / day</div>
            {dailyValues.length >= 2 ? (
              <Sparkline
                values={dailyValues}
                width={264}
                height={32}
                className="text-sky-500"
              />
            ) : (
              <div className="flex h-8 items-center text-xs text-muted-foreground">
                Not enough data for a trend yet.
              </div>
            )}
          </div>

          <div className="border-t pt-2">
            {canLoadMore ? (
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md border bg-card px-3 py-1.5 text-sm font-medium hover:bg-muted/50 disabled:opacity-60"
              >
                {loadingMore && <Spinner size={13} />}
                {loadingMore ? "Loading…" : `Load ${nextWindowLabel}`}
              </button>
            ) : (
              <div className="text-center text-xs text-muted-foreground">
                All data loaded
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
