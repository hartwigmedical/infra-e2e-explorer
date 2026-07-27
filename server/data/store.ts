/**
 * E2e data store for the server-side data layer (SSR experiment, Phase 1).
 *
 * The server-side replacement for app/contexts/E2eDataContext.tsx: it resolves a
 * window's run list, ensures each run's slim Parquet (slim-cache.ts), and
 * materializes the analytical tables the app queries - runs / scenarios / steps /
 * test_ids / service_versions - over the slim data. Route loaders then run plain
 * SQL against those tables via `query()`.
 *
 * All SQL comes from app/lib/e2e-views.ts (the same builders the SPA uses), so
 * there is ONE source of truth for the schema and the analysis. The key
 * simplification vs. the WASM path: native DuckDB has real memory, so there is
 * no two-stage "runs-ready then details-ready" split and no wasm-OOM
 * scenarios-only fallback - the full materialization always runs.
 *
 * `refresh(since)` rebuilds the tables for the requested window (mirroring the
 * SPA's per-window materialization). It's serialized so concurrent SSR requests
 * asking for the same/overlapping window don't rebuild on top of each other.
 */

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildRunsViewSql,
  buildFeaturesViewSql,
  buildEmptySlimSelectSql,
  buildScenariosStepsViewsSql,
  buildTestIdsSelectSql,
  buildServiceVersionsSelectSql,
} from "../../app/lib/e2e-views.ts";
import { query as duckQuery, run as duckRun } from "./engine.ts";
import { SlimCache } from "./slim-cache.ts";
import { createReportSource, type ReportSource } from "./sources.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface WindowState {
  since: string;
  /** Runs materialized into the tables (i.e. within the window). */
  runCount: number;
}

export class E2eStore {
  private cache: SlimCache;
  private workDir: string;
  /** Serializes refreshes so overlapping SSR requests don't race the rebuild. */
  private refreshChain: Promise<WindowState> = Promise.resolve({
    since: "",
    runCount: 0,
  });
  private current: WindowState | null = null;
  /** When `current` was last materialized (epoch ms); 0 = never. */
  private materializedAt = 0;
  /** How long a materialized window is reused before a rebuild picks up new
   *  runs. Short, like the server's run-list cache - the bucket is append-only. */
  private readonly windowTtlMs = 60_000;

  constructor(
    private source: ReportSource = createReportSource(),
    workDir = process.env.E2E_CACHE_DIR
      ? path.join(process.env.E2E_CACHE_DIR, "work")
      : path.join(REPO_ROOT, ".cache", "work"),
  ) {
    this.cache = new SlimCache(this.source);
    this.workDir = workDir;
  }

  /** The window currently materialized into the tables, if any. */
  get window(): WindowState | null {
    return this.current;
  }

  /**
   * Rebuild runs/scenarios/steps/test_ids/service_versions for `since` (a
   * YYYY-MM-DD cutoff; runs with run_id[:10] >= since are included). Returns the
   * materialized window. Serialized via refreshChain.
   */
  refresh(since: string): Promise<WindowState> {
    this.refreshChain = this.refreshChain
      .catch(() => ({ since: "", runCount: 0 }) as WindowState)
      .then(() => this.doRefresh(since));
    return this.refreshChain;
  }

  /**
   * Ensure `since`'s window is materialized, reusing it when it's the current
   * window and still fresh (within windowTtlMs). Concurrent loaders in one SSR
   * request (layout + route) both call this; because the check runs inside the
   * serialized chain, only the first rebuilds and the rest are no-ops.
   */
  ensureWindow(since: string): Promise<WindowState> {
    this.refreshChain = this.refreshChain
      .catch(() => ({ since: "", runCount: 0 }) as WindowState)
      .then(() => {
        if (
          this.current?.since === since &&
          Date.now() - this.materializedAt < this.windowTtlMs
        ) {
          return this.current;
        }
        return this.doRefresh(since);
      });
    return this.refreshChain;
  }

  private async doRefresh(since: string): Promise<WindowState> {
    await mkdir(this.workDir, { recursive: true });

    const runs = await this.source.listRuns(since);

    // v_runs: reuse the exact run-list SQL (date/status/nightly parsing) by
    // writing the window's run list to a JSON file read_json can consume.
    const runsJsonPath = path.join(this.workDir, "runs.json");
    await writeFile(
      runsJsonPath,
      JSON.stringify(
        runs.map((r) => ({
          run_id: r.run_id,
          source: r.source,
          updated: r.updated,
          size_bytes: r.size_bytes,
        })),
      ),
    );
    await duckRun(buildRunsViewSql(runsJsonPath));
    await duckRun(`CREATE OR REPLACE TABLE runs AS SELECT * FROM v_runs;`);

    // Slim Parquet for the whole window (cached; only new runs pay to extract).
    const slimPaths = await this.cache.ensureMany(runs);

    // v_features over the window's slim files. With none, write a typed
    // zero-row placeholder so the views/tables still exist with the right schema.
    let featureFiles = slimPaths;
    if (featureFiles.length === 0) {
      const placeholder = path.join(this.workDir, "slim_empty.parquet");
      await duckRun(
        `COPY (${buildEmptySlimSelectSql()}) TO '${placeholder}' (FORMAT parquet);`,
      );
      featureFiles = [placeholder];
    }
    await duckRun(buildFeaturesViewSql(featureFiles));
    await duckRun(buildScenariosStepsViewsSql());

    // test_ids: one cheap pass over the slim data.
    await duckRun(
      `CREATE OR REPLACE TABLE test_ids AS ${buildTestIdsSelectSql()};`,
    );

    // scenarios + steps: the full materialization (no wasm-OOM fallback needed).
    await duckRun(`
      CREATE OR REPLACE TABLE scenarios_raw AS SELECT * FROM v_scenarios;
      CREATE OR REPLACE TABLE steps AS
        SELECT sc.run_id, sc.feature_uri, sc.scenario_id, sc.scenario_name,
          trim(s.keyword)||' '||s.name AS step_label, s.name AS step_name, trim(s.keyword) AS step_keyword,
          row_number() OVER (PARTITION BY sc.run_id, sc.scenario_id ORDER BY s.line) AS step_ordinal,
          s.is_background AS is_background,
          s.result.status AS status, s.result.duration/1e9 AS duration_s,
          (s.result.error_message IS NOT NULL) AS has_error,
          left(s.result.error_message, 2000) AS error_message, s.match.location AS glue_location
        FROM scenarios_raw sc, UNNEST(sc.steps) AS t(s);
      CREATE OR REPLACE TABLE scenarios AS
        SELECT sr.* EXCLUDE (steps), ti.test_id
        FROM scenarios_raw sr
        LEFT JOIN test_ids ti USING (run_id, scenario_id);
      DROP TABLE scenarios_raw;
    `);

    // service_versions: analysis over the stored logs.
    await duckRun(
      `CREATE OR REPLACE TABLE service_versions AS ${buildServiceVersionsSelectSql()};`,
    );

    this.current = { since, runCount: runs.length };
    this.materializedAt = Date.now();
    return this.current;
  }

  /** Run a SELECT against the materialized tables. */
  query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    return duckQuery<T>(sql);
  }
}

/** Process-wide store (one materialized DuckDB shared across requests). */
let storeSingleton: E2eStore | null = null;
export function getStore(): E2eStore {
  if (!storeSingleton) storeSingleton = new E2eStore();
  return storeSingleton;
}
