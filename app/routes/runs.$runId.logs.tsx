import type { Route } from "./+types/runs.$runId.logs";
import { ensureWindow, query } from "~/lib/data.server";
import { windowIndexFromRequest } from "~/lib/window";

/**
 * Resource route (loader only, no component) for a run's per-scenario logs -
 * the run-detail "Log" button fetches this on demand via useFetcher, so the
 * (potentially large) decoded logs never bloat the run-detail SSR payload.
 *
 * Logs live in the window's slim Parquet (decoded at extraction time), exposed
 * as v_features by the store; this reads them for the one run. The `?w=` param
 * must match the run-detail page's window so the run is in the materialized
 * view.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
  await ensureWindow(windowIndexFromRequest(request));
  const runId = params.runId ?? "";
  const lit = `'${runId.replace(/'/g, "''")}'`;
  const logs = await query<{ scenario_id: string; log: string | null }>(
    `SELECT e.id AS scenario_id, e.log AS log
     FROM v_features f, UNNEST(f.elements) AS t(e)
     WHERE f.run_id = ${lit} AND e."type" = 'scenario'`,
  );
  return { logs };
}
