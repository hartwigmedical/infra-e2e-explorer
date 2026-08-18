import { useEffect, useRef } from "react";
import { useRevalidator } from "react-router";
import Spinner from "~/components/Spinner";

/** How often to re-check while the model is still building. A revalidation
 *  re-runs the page's loaders, so this is deliberately unhurried. */
const POLL_MS = 5000;

export interface BuildProgressProps {
  /** Runs whose report is extracted and queryable. */
  ready: number;
  /** Runs in the window (ready + still being extracted). */
  total: number;
}

/**
 * The "still building" banner.
 *
 * A cold instance (empty cache dir, fresh deploy, bumped CACHE_VERSION) has to
 * extract every run's report before the scenario data exists. The store serves
 * whatever is already extracted rather than blocking (see server/data/store.ts),
 * so the run list is usable immediately - but half-populated pages need to say so
 * instead of looking like a dataset with holes in it. Renders nothing once every
 * run is in, which is the normal case: the cache lives on a shared mount, so a
 * new instance usually starts warm.
 */
export default function BuildProgress({ ready, total }: BuildProgressProps) {
  const pending = Math.max(0, total - ready);
  const { revalidate, state } = useRevalidator();
  // Read through a ref so a revalidation in flight doesn't re-arm the interval.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (pending === 0) return;
    const timer = setInterval(() => {
      if (stateRef.current === "idle") void revalidate();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, revalidate]);

  if (pending === 0) return null;

  const pct = total > 0 ? Math.round((ready / total) * 100) : 0;
  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 rounded-lg border border-dashed bg-muted/40 p-3"
    >
      <div className="flex items-center gap-2 text-sm">
        <Spinner />
        <span className="font-medium">Building data model</span>
        <span className="text-muted-foreground">
          {ready} / {total} runs ready
        </span>
      </div>
      <p className="mt-1 pl-5 text-xs text-muted-foreground">
        Extracting run reports. Scenario data appears as runs finish; this page
        updates itself.
      </p>
      <div
        className="mt-2 ml-5 h-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full bg-primary transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
