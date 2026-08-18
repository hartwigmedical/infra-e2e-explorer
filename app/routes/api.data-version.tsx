import { ensureData } from "~/lib/data.server";

/**
 * Tiny resource route the client polls to learn whether the dataset moved.
 *
 * `ensureData()` never blocks once a model exists (see E2eStore.ensure), so this
 * both answers instantly AND is what nudges a stale model to refresh behind the
 * request - an open tab keeps the server's data current just by polling.
 *
 * `revision` only changes when a rebuild produced a different dataset, so a
 * client can distinguish "re-materialized, same data" from "there's something
 * new" and only interrupt the user for the latter.
 */
export async function loader() {
  const state = await ensureData();
  return {
    revision: state.revision,
    runCount: state.runCount,
    cachedRunCount: state.cachedRunCount,
    pendingRunCount: state.pendingRunCount,
    newestRunId: state.newestRunId,
  };
}
