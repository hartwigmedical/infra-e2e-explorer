import { useEffect, useMemo, useRef, useState } from "react";
import { useRouteLoaderData } from "react-router";
import { CalendarRange, ChevronDown } from "lucide-react";
import { eachDayOfInterval, format } from "date-fns";
import { useRunScope } from "~/contexts/RunScopeContext";
import Sparkline from "~/components/Sparkline";
import { cn } from "~/lib/utils";
import type { ShellData } from "~/layout";

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

/** "YYYY-MM-DD" for a local-midnight Date, matching the loader's day keys. */
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
 * Shared run-scope control (top-right on every page). The server holds ALL runs,
 * so there's no window to pick any more - the only choice here is the
 * nightly/all-runs view scope (a client preference, see RunScopeContext). The
 * popover also shows the full loaded date range + a runs/day sparkline for
 * context. All data comes from the shell loader (see app/layout.tsx).
 *
 * Dependency-free popover: a relatively-positioned wrapper, an absolutely-
 * positioned panel below it, closed on click-outside or Escape.
 */
export default function DateRangeControl() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const shell = useRouteLoaderData("layout") as ShellData | undefined;
  const { nightlyOnly, setNightlyOnly } = useRunScope();

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

  const runCount = shell?.runCount ?? 0;
  const oldest = parseYMD(shell?.range.oldest);
  const newest = parseYMD(shell?.range.newest);
  const rangeLabel = formatRange(oldest, newest);

  // Gap-fill: enumerate every calendar day from oldest -> newest and map to that
  // day's run count (0 where there's no run), so the sparkline reflects true
  // daily density instead of silently skipping gaps.
  const dailyValues = useMemo(() => {
    if (!oldest || !newest) return [];
    const countByDay = new Map((shell?.daily ?? []).map((r) => [r.day, r.n]));
    const days = eachDayOfInterval({ start: oldest, end: newest });
    return days.map((d) => countByDay.get(toDayKey(d)) ?? 0);
  }, [oldest, newest, shell?.daily]);

  return (
    <div ref={ref} className={cn("relative")}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground",
          open && "border-primary/40 bg-accent",
        )}
      >
        <CalendarRange className="size-4 opacity-70" />
        <span className="font-medium">
          {nightlyOnly ? "Nightly runs" : "All runs"}
        </span>
        <ChevronDown className="size-3.5 opacity-60" />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-72 space-y-3 rounded-md border bg-popover p-3 text-popover-foreground shadow-md">
          <div>
            <div className="mb-1 text-xs text-muted-foreground">Runs</div>
            <div className="flex rounded-md border p-0.5 text-sm">
              {[
                { on: true, label: "Nightly runs" },
                { on: false, label: "All runs" },
              ].map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => setNightlyOnly(opt.on)}
                  className={cn(
                    "flex-1 rounded px-2 py-1 transition-colors",
                    nightlyOnly === opt.on
                      ? "bg-accent font-medium text-accent-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
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
        </div>
      )}
    </div>
  );
}
