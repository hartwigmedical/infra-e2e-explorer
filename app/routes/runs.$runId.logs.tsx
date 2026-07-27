import type { Route } from "./+types/runs.$runId.logs";
import { ensureData, query } from "~/lib/data.server";

/**
 * Resource route (loader only, no component) for a run's per-scenario logs -
 * the run-detail "Log" button fetches this on demand via useFetcher, so the
 * (potentially large) decoded logs never bloat the run-detail SSR payload.
 *
 * Logs live in the slim Parquet (decoded at extraction time), exposed as
 * v_features by the store; this reads them for the one run.
 */
export async function loader({ params }: Route.LoaderArgs) {
  await ensureData();
  const runId = params.runId ?? "";
  const lit = `'${runId.replace(/'/g, "''")}'`;
  const logs = await query<{ scenario_id: string; log: string | null }>(
    `SELECT e.id AS scenario_id, e.log AS log
     FROM v_features f, UNNEST(f.elements) AS t(e)
     WHERE f.run_id = ${lit} AND e."type" = 'scenario'`,
  );
  return { logs };
}
