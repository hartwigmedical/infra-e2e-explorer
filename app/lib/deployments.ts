/**
 * Shared deployment-suspicion logic, used by both the Services timeline
 * (app/routes/services.tsx) and the Scenarios "stability" view
 * (app/routes/scenarios.tsx) so the two agree on what a "suspect deploy" is.
 *
 * The inputs are all derived from the in-scope run set:
 *  - statusByScenario: scenario_id -> (run column index -> status)
 *  - newlyFailedByIdx: run column index -> set of scenario_ids that FAILED that
 *    run but PASSED at the scenario's previous appearance (a regression)
 *  - specByService:   service -> array (indexed by run column) of the deployed
 *    version spec that run, or null when the service was absent
 */

export interface RunDeployFlags {
  /** Any service's version changed at this run (vs the previous run in scope). */
  hasDeploy: boolean;
  /** Any of those changes is a "suspect" — see makeIsSuspectDeploy. */
  hasSuspectDeploy: boolean;
}

/**
 * A version change landing at column `startIdx` and held through `endIdx` (the
 * end of that version's tenure) is a SUSPECT when it coincided with new
 * failures that were NOT resolved later while the same version stayed deployed.
 * If every scenario that newly failed at the deploy passes again on a later run
 * within the tenure, the version cleared itself → not a suspect (transient /
 * flaky, or fixed without a version bump).
 */
export function makeIsSuspectDeploy(
  statusByScenario: Map<string, Map<number, string>>,
  newlyFailedByIdx: Map<number, Set<string>>,
): (startIdx: number, endIdx: number) => boolean {
  return (startIdx, endIdx) => {
    const nf = newlyFailedByIdx.get(startIdx);
    if (!nf || nf.size === 0) return false;
    for (const sid of nf) {
      const seq = statusByScenario.get(sid);
      let resolved = false;
      for (let k = startIdx + 1; k <= endIdx; k++) {
        if (seq?.get(k) === "passed") {
          resolved = true;
          break;
        }
      }
      if (!resolved) return true; // this new failure lingered under this version
    }
    return false;
  };
}

/**
 * Pivot flat (run, service, spec) rows into service -> spec-per-run-column,
 * with null where the service didn't appear in a run.
 */
export function buildSpecByService(
  versionRows: { run_id: string; service: string; spec: string | null }[],
  runIndex: Map<string, number>,
  runCount: number,
): Map<string, (string | null)[]> {
  const m = new Map<string, (string | null)[]>();
  for (const r of versionRows) {
    const idx = runIndex.get(r.run_id);
    if (idx == null) continue;
    let arr = m.get(r.service);
    if (!arr) {
      arr = new Array<string | null>(runCount).fill(null);
      m.set(r.service, arr);
    }
    arr[idx] = r.spec;
  }
  return m;
}

/**
 * Per-run-column deploy flags across all services. A deploy is a spec change at
 * column i (i > 0, differing from the previous column); its suspect flag comes
 * from `isSuspect` over the version's tenure [i .. next change - 1].
 */
export function computeRunDeployFlags(
  runCount: number,
  specByService: Map<string, (string | null)[]>,
  isSuspect: (startIdx: number, endIdx: number) => boolean,
): Map<number, RunDeployFlags> {
  const out = new Map<number, RunDeployFlags>();
  const flag = (i: number): RunDeployFlags => {
    let f = out.get(i);
    if (!f) {
      f = { hasDeploy: false, hasSuspectDeploy: false };
      out.set(i, f);
    }
    return f;
  };
  for (const specAt of specByService.values()) {
    let i = 0;
    while (i < runCount) {
      const spec = specAt[i];
      if (spec == null) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < runCount && specAt[j] === spec) j++;
      if (i > 0 && specAt[i - 1] !== spec) {
        const f = flag(i);
        f.hasDeploy = true;
        if (isSuspect(i, j - 1)) f.hasSuspectDeploy = true;
      }
      i = j;
    }
  }
  return out;
}
