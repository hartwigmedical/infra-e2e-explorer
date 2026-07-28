/**
 * E2e data store for the server-side data layer.
 *
 * Holds the FULL dataset (no window): it lists every run, ensures each run's
 * extracted Parquet (cache.ts), and materializes the lightweight analytical
 * tables the app queries broadly - runs / scenarios / test_ids /
 * service_versions - over the extracted data. Route loaders run plain SQL against
 * those via `query()`.
 *
 * `steps` is deliberately NOT materialized: it's ~90% of the rows and is only
 * needed one-run (run detail) or one-scenario (step history) at a time, so it's
 * left as the `v_steps` VIEW over the cached Parquet and read on demand. That
 * keeps the resident footprint small (~0.1 MB/run) as the append-only bucket
 * grows.
 *
 * All SQL comes from app/lib/e2e-views.ts (one source of truth). `ensure()`
 * (re)builds the tables over ALL runs, serialized so overlapping SSR requests
 * don't race, and reused within a short TTL so bursts don't rebuild. The warmer
 * re-runs it periodically to pick up new runs (see warm.ts).
 */

import {
  buildRunsTableSql,
  buildFeaturesViewSql,
  buildEmptyFeaturesViewSql,
  buildScenariosStepsViewsSql,
  buildTestIdsSelectSql,
  buildServiceVersionsSelectSql,
} from "../../app/lib/e2e-views.ts";
import { query as duckQuery, run as duckRun } from "./engine.ts";
import { ReportCache } from "./cache.ts";
import { createReportSource, type ReportSource } from "./sources.ts";
import { startWarming } from "./warm.ts";

/** `since` that includes every run (run ids start with a 4-digit year). */
const ALL_SINCE = "0000-01-01";

export interface StoreState {
  /** Number of runs materialized (i.e. the whole dataset). */
  runCount: number;
}

export class E2eStore {
  private cache: ReportCache;
  /** Serializes rebuilds so overlapping SSR requests don't race. */
  private chain: Promise<StoreState> = Promise.resolve({ runCount: 0 });
  private current: StoreState | null = null;
  /** When `current` was last materialized (epoch ms); 0 = never. */
  private materializedAt = 0;
  /** How long a materialization is reused before a rebuild picks up new runs.
   *  Short, like the old run-list cache - the bucket is append-only. */
  private readonly refreshTtlMs = 60_000;

  constructor(private source: ReportSource = createReportSource()) {
    this.cache = new ReportCache(this.source);
  }

  /** The materialized dataset, if any. */
  get state(): StoreState | null {
    return this.current;
  }

  /**
   * Ensure the full dataset is materialized, reusing it within refreshTtlMs.
   * Concurrent loaders in one SSR request (layout + route) both call this;
   * because the freshness check runs inside the serialized chain, only the first
   * rebuilds and the rest are no-ops. Pass `force` to bypass the TTL (the warmer
   * uses this to pick up new runs on its own cadence).
   */
  ensure(force = false): Promise<StoreState> {
    this.chain = this.chain
      .catch(() => ({ runCount: 0 }) as StoreState)
      .then(() => {
        if (
          !force &&
          this.current &&
          Date.now() - this.materializedAt < this.refreshTtlMs
        ) {
          return this.current;
        }
        return this.rebuild();
      });
    return this.chain;
  }

  private async rebuild(): Promise<StoreState> {
    const runs = await this.source.listRuns(ALL_SINCE);

    // runs table built in-memory from the run list (VALUES) - no runs.json file.
    await duckRun(
      `CREATE OR REPLACE TABLE runs AS ${buildRunsTableSql(
        runs.map((r) => ({
          run_id: r.run_id,
          source: r.source,
          updated: r.updated,
          size_bytes: r.size_bytes,
        })),
      )};`,
    );

    // Cached Parquet for every run (cached; only new runs pay to extract).
    const files = await this.cache.ensureMany(runs);

    // v_features over all cached files, or a typed zero-row view when there are
    // none - so the derived views/tables always exist with the right schema (no
    // placeholder file needed).
    await duckRun(
      files.length > 0
        ? buildFeaturesViewSql(files)
        : buildEmptyFeaturesViewSql(),
    );
    // Creates the v_scenarios + v_steps VIEWS. v_steps is queried on demand for
    // run-detail steps and scenario step-history - we never materialize it.
    await duckRun(buildScenariosStepsViewsSql());

    // test_ids: one cheap pass over the extracted data.
    await duckRun(
      `CREATE OR REPLACE TABLE test_ids AS ${buildTestIdsSelectSql()};`,
    );

    // scenarios: one row per (run, scenario) with its test_id, minus the heavy
    // steps list (that stays in v_steps). Small enough to hold for all runs.
    await duckRun(`
      CREATE OR REPLACE TABLE scenarios AS
        SELECT sr.* EXCLUDE (steps), ti.test_id
        FROM v_scenarios sr
        LEFT JOIN test_ids ti USING (run_id, scenario_id);
    `);

    // service_versions: analysis over the stored logs.
    await duckRun(
      `CREATE OR REPLACE TABLE service_versions AS ${buildServiceVersionsSelectSql()};`,
    );

    this.current = { runCount: runs.length };
    this.materializedAt = Date.now();
    return this.current;
  }

  /** Run a SELECT against the materialized tables / views. */
  query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    return duckQuery<T>(sql);
  }
}

/** Process-wide store (one materialized DuckDB shared across requests). */
let storeSingleton: E2eStore | null = null;
export function getStore(): E2eStore {
  if (!storeSingleton) {
    storeSingleton = new E2eStore();
    // Kick off background warming from here so it shares THIS singleton (see
    // warm.ts for why the module graph matters).
    startWarming(storeSingleton);
  }
  return storeSingleton;
}
