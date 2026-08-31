import { redirect, type ShouldRevalidateFunctionArgs } from "react-router";
import type { Route } from "./+types/runs.$runId.logs";
import {
  ensureData,
  loadOutOfWindowRun,
  query,
  runRelation,
} from "~/lib/data.server";

/**
 * Resource route (loader only, no component) for a run's per-scenario logs -
 * the run-detail "Log" button fetches this on demand via useFetcher, so the
 * (potentially large) decoded logs never bloat the run-detail SSR payload.
 *
 * Logs live in the cached Parquet (decoded at extraction time), exposed as
 * v_features by the store; this reads them for the one run. A run outside the
 * store's window isn't in v_features, so it's read from its own Parquet instead -
 * the same on-demand path the run-detail loader uses.
 *
 * `?fetch=1` marks a real fetcher call. Without it this URL is a person or a
 * crawler following the path by hand, and since the module has no component it
 * would render the app shell with an empty <main>; redirect them to the run page
 * instead. An explicit param beats sniffing Accept/Sec-Fetch-* headers.
 *
 * Never throws: a failure comes back as `{ error }` so the fetcher can surface it
 * (a thrown loader error would take out the whole run-detail page instead).
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const runId = params.runId ?? "";
  const runPath = `/runs/${encodeURIComponent(runId)}`;
  if (new URL(request.url).searchParams.get("fetch") !== "1") {
    throw redirect(runPath);
  }

  try {
    await ensureData();
    const lit = `'${runId.replace(/'/g, "''")}'`;

    // This run's own Parquet when it's cached - v_features is a view over every
    // file in the window and the run_id filter doesn't prune it (measured 30ms vs
    // 4ms over 60 runs). Falls back to the on-demand path for a run outside the
    // window, and to the view for one that's listed but not extracted yet.
    const features =
      runRelation(runId) ??
      ((
        await query<{ x: number }>(
          `SELECT 1 AS x FROM runs WHERE run_id = ${lit}`,
        )
      ).length
        ? "v_features"
        : (await loadOutOfWindowRun(runId))?.features);
    if (!features) {
      return { runId, logs: [], error: `Run ${runId} not found.` };
    }

    const logs = await query<{ scenario_id: string; log: string | null }>(
      `SELECT e.id AS scenario_id, e.log AS log
       FROM ${features} f, UNNEST(f.elements) AS t(e)
       WHERE f.run_id = ${lit} AND e."type" = 'scenario'`,
    );
    return { runId, logs, error: null as string | null };
  } catch (err) {
    console.warn(`[logs] failed for ${runId}:`, (err as Error)?.message ?? err);
    return {
      runId,
      logs: [] as { scenario_id: string; log: string | null }[],
      error: "Could not load logs for this run.",
    };
  }
}

/**
 * Fetcher loads revalidate after a navigation by default, and run detail turns
 * every filter change into one - so with a log panel open, each keystroke in the
 * test-id box re-downloaded this whole payload (the decoded logs for every
 * scenario in the run). Nothing here reads the search string beyond the
 * `?fetch=1` marker, so only a different run is worth re-reading; the run-detail
 * component clears its log panels on a run change anyway.
 */
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  currentParams,
  nextParams,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (currentUrl.toString() === nextUrl.toString())
    return defaultShouldRevalidate;
  return currentParams.runId !== nextParams.runId;
}
