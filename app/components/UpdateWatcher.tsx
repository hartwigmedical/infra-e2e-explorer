import { useEffect, useRef } from "react";
import { useRevalidator } from "react-router";
import { toast } from "sonner";

/** How often to ask the server whether the dataset moved. Cheap: the endpoint
 *  reads the store's current state, it never rebuilds in the request. */
const POLL_MS = 20_000;

export interface UpdateWatcherProps {
  /** Dataset revision this page was rendered from (shell loader). */
  revision: number;
  /** Newest run at render time, so the toast can say what changed. */
  newestRunId: string | null;
  /** Runs still being extracted; while any are, BuildProgress is already
   *  polling and refreshing on its own, so this stays quiet. */
  pendingRunCount: number;
}

interface VersionPayload {
  revision: number;
  newestRunId: string | null;
  pendingRunCount: number;
}

/**
 * Tells the user when the data behind the page has moved on.
 *
 * The server serves a stale model rather than making a request wait for a
 * rebuild (see E2eStore.ensure), which means an open page can be looking at data
 * the server has since replaced. Rather than silently re-rendering under the
 * reader - the page is a table people are mid-scroll in, mid-filter on - we poll
 * a small endpoint and offer a refresh.
 *
 * Renders nothing; the toast is the whole UI.
 */
export default function UpdateWatcher({
  revision,
  newestRunId,
  pendingRunCount,
}: UpdateWatcherProps) {
  const { revalidate } = useRevalidator();
  // The revision this page's data came from, and the last one we've announced,
  // so a standing toast isn't raised again on every poll.
  const rendered = useRef(revision);
  const announced = useRef(revision);
  rendered.current = revision;
  // The standing toast, so it can be taken down once the page catches up.
  const toastId = useRef<string | number | null>(null);

  // Clear the toast when this page is showing the revision it announced -
  // whether that came from the Refresh action, a navigation, or BuildProgress
  // revalidating. Sonner does not dismiss on action click by itself, and a
  // "refresh available" notice that outlives the refresh is just noise.
  useEffect(() => {
    if (toastId.current !== null && revision >= announced.current) {
      toast.dismiss(toastId.current);
      toastId.current = null;
    }
  }, [revision]);

  useEffect(() => {
    if (pendingRunCount > 0) return;
    let cancelled = false;

    const check = async () => {
      try {
        const res = await fetch("/api/data-version", {
          headers: { accept: "application/json" },
        });
        if (!res.ok) return;
        const next = (await res.json()) as VersionPayload;
        if (cancelled) return;
        if (
          next.revision <= rendered.current ||
          next.revision === announced.current
        ) {
          return;
        }
        announced.current = next.revision;
        const isNewRun =
          next.newestRunId != null && next.newestRunId !== newestRunId;
        toastId.current = toast.info(
          isNewRun ? "A new run has landed" : "Updated data available",
          {
            duration: Infinity,
            action: { label: "Refresh", onClick: () => revalidate() },
          },
        );
      } catch {
        // Offline, server restarting, navigation aborting the fetch: the next
        // tick tries again. Never surfaced - this is a background nicety.
      }
    };

    const timer = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pendingRunCount, newestRunId, revalidate]);

  return null;
}
