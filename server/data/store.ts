/**
 * E2e data store for the server-side data layer.
 *
 * Holds a rolling WINDOW of runs (WINDOW_DAYS, default 90): it lists the runs in
 * that window, ensures each one's extracted Parquet (cache.ts), and materializes
 * the lightweight analytical tables the app queries broadly - runs / scenarios /
 * test_ids / service_versions - over the extracted data. Route loaders run plain
 * SQL against those via `query()`.
 *
 * The window is what keeps this cheap: the bucket is append-only since 2023, so
 * without it both the GCS listing and the per-rebuild analysis pass would grow
 * with the lifetime of the project rather than with what anyone looks at. Older
 * runs are still reachable by direct link - `outOfWindowRun()` extracts one on
 * demand and hands back a relation over its own Parquet.
 *
 * `steps` is deliberately NOT materialized: it's ~90% of the rows and is only
 * needed one-run (run detail) or one-scenario (step history) at a time, so it's
 * left as the `v_steps` VIEW over the cached Parquet and read on demand. That
 * keeps the resident footprint small (~0.1 MB/run) as the append-only bucket
 * grows.
 *
 * All SQL comes from app/lib/e2e-views.ts (one source of truth). `ensure()`
 * (re)builds the tables over the window, serialized so overlapping SSR requests
 * don't race, and reused within a short TTL so bursts don't rebuild. The warmer
 * re-runs it periodically to pick up new runs (see warm.ts).
 *
 * `ensure()` NEVER waits on extraction: it materializes over the runs whose
 * Parquet is already cached and kicks off the rest in the background. A cold
 * instance (empty cache dir, bumped CACHE_VERSION, fresh deploy) would otherwise
 * make every request - including `/` - block for minutes on the first full
 * extraction, which on Cloud Run means 504s and a container killed before it
 * ever serves a page. The dashboard instead paints the run list immediately and
 * fills in scenario data as runs land (each rebuild after the TTL picks up
 * whatever finished). `ensureComplete()` is the waiting variant, for the warmer
 * and the measurement scripts.
 */

import {
  buildRunsTableSql,
  buildFeaturesViewSql,
  buildEmptyFeaturesViewSql,
  buildScenariosStepsViewsSql,
  buildTestIdsSelectSql,
  buildServiceVersionsSelectSql,
  readParquetSql,
} from "../../app/lib/e2e-views.ts";
import { query as duckQuery, withConnection } from "./engine.ts";
import { ReportCache } from "./cache.ts";
import {
  createReportSource,
  type ReportSource,
  type RunInfo,
} from "./sources.ts";
import { startWarming } from "./warm.ts";

/** `since` that includes every run (run ids start with a 4-digit year). */
const ALL_SINCE = "0000-01-01";

/**
 * How far back the model reaches, in days. The bucket is append-only and keeps
 * every run since 2023, but the dashboard is a "what happened recently" tool, so
 * holding a rolling window instead of all history keeps BOTH the GCS listing and
 * the per-rebuild analysis pass proportional to the window rather than to the
 * lifetime of the project. A run older than the window is still reachable by
 * direct link - it's extracted on demand and read from its own Parquet (see
 * outOfWindowRun), it just isn't part of the materialized model.
 *
 * `E2E_WINDOW_DAYS=0` disables the window (every run since 2023) - useful for
 * the measurement scripts and one-off backfills.
 */
const WINDOW_DAYS = (() => {
  const raw = Number(process.env.E2E_WINDOW_DAYS ?? 90);
  return Number.isFinite(raw) && raw >= 0 ? raw : 90;
})();

const DAY_MS = 86_400_000;

/** The window's `since` date (YYYY-MM-DD), compared against run_id[:10]. */
function windowSince(now = Date.now()): string {
  if (WINDOW_DAYS === 0) return ALL_SINCE;
  return new Date(now - WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
}

/** Run ids are folder names that end up in file paths and bucket object names,
 *  and one can arrive from a URL (an out-of-window deep link), so anything that
 *  isn't shaped like a run id is rejected before it gets that far. */
function isRunIdShaped(runId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId);
}

/** One run read straight from its own cached Parquet, outside the model. */
export interface OutOfWindowRun {
  run: RunInfo;
  /** SQL relation over just this run's Parquet, for the parameterized builders
   *  in e2e-views.ts (buildScenariosSelectSql, buildTestIdsSelectSql, …). */
  features: string;
}

export interface StoreState {
  /** Number of runs in the window. */
  runCount: number;
  /** Of those, how many have their extracted Parquet materialized. */
  cachedRunCount: number;
  /** Of those, how many are still waiting on background extraction. */
  pendingRunCount: number;
  /** The window's start date (YYYY-MM-DD), or null when it's disabled. */
  windowSince: string | null;
}

const EMPTY_STATE: StoreState = {
  runCount: 0,
  cachedRunCount: 0,
  pendingRunCount: 0,
  windowSince: null,
};

/** Identity of a run VERSION: a re-upload (new size/source) is a new key, so it
 *  gets re-extracted, while a permanently failing run isn't retried forever. */
function runKey(run: RunInfo): string {
  return `${run.run_id}:${run.source}:${run.size_bytes}`;
}

export class E2eStore {
  private cache: ReportCache;
  /** Serializes rebuilds so overlapping SSR requests don't race. */
  private chain: Promise<StoreState> = Promise.resolve(EMPTY_STATE);
  private current: StoreState | null = null;
  /** In-flight background extraction pass, if any (never rejects). */
  private extraction: Promise<void> | null = null;
  /** Run versions already attempted this process (see runKey), so a rebuild
   *  doesn't re-extract runs that just failed. */
  private attempted = new Set<string>();
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
   * Ensure the dataset is materialized over everything currently cached, reusing
   * it within refreshTtlMs. Concurrent loaders in one SSR request (layout +
   * route) both call this; because the freshness check runs inside the serialized
   * chain, only the first rebuilds and the rest are no-ops. Pass `force` to
   * bypass the TTL (the warmer uses this to pick up new runs on its own cadence).
   *
   * Returns as soon as the tables exist - runs still being extracted show up in
   * `pendingRunCount` and land in a later rebuild.
   */
  ensure(force = false): Promise<StoreState> {
    this.chain = this.chain
      .catch(() => EMPTY_STATE)
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

  /**
   * Like `ensure()`, but waits for pending extraction and re-materializes over
   * the result: the FULL dataset, at the cost of taking as long as extraction
   * does. For background work (the warmer) and the measurement scripts - never
   * for a request.
   */
  async ensureComplete(force = false): Promise<StoreState> {
    let state = await this.ensure(force);
    // Keep going until nothing is in flight AND nothing is pending. Checking
    // `this.extraction` alone isn't enough: a rebuild can race an in-flight
    // extraction pass and materialize a partial count, then the pass finishes
    // before we look - leaving runs on disk but out of the model. Bounded by
    // `attempted`: a pass that extracts nothing new makes no progress and ends
    // the loop, so runs that keep failing can't spin it.
    while (this.extraction || state.pendingRunCount > 0) {
      const pendingBefore = state.pendingRunCount;
      if (this.extraction) await this.extraction;
      state = await this.ensure(true);
      if (!this.extraction && state.pendingRunCount >= pendingBefore) break;
    }
    return state;
  }

  private async rebuild(): Promise<StoreState> {
    // Up front and fatal: see ReportCache.ensureWritable.
    await this.cache.ensureWritable();
    const since = windowSince();
    const runs = await this.source.listRuns(since);

    // What's extracted already vs. what still needs to be. Only the former is
    // materialized here; the latter is extracted in the background so no request
    // waits on a parse (see the header).
    const { cached, missing } = await this.cache.partition(runs);
    await this.materialize(runs, cached);

    this.current = {
      runCount: runs.length,
      cachedRunCount: cached.length,
      pendingRunCount: missing.length,
      windowSince: since === ALL_SINCE ? null : since,
    };
    this.materializedAt = Date.now();
    this.startExtraction(missing);
    return this.current;
  }

  /**
   * (Re)create the run list, views and tables over the extracted Parquet files.
   *
   * ONE TRANSACTION on its OWN connection, for two reasons. Atomicity: the
   * statements below take a while over a full window, and readers used to
   * interleave between them - so during a re-warm the dashboard could show new
   * run rows with blank scenario counts, and the Scenarios matrix could gain
   * columns with no cells. DuckDB's DDL is transactional, so readers on the
   * shared connection now see either the whole previous model or the whole new
   * one. Off the shared connection: a rebuild no longer occupies the connection
   * every loader query has to take its turn on.
   */
  private async materialize(runs: RunInfo[], files: string[]): Promise<void> {
    await withConnection(async (conn) => {
      await conn.run("BEGIN TRANSACTION;");
      try {
        // runs table built in-memory from the run list (VALUES) - no runs.json.
        await conn.run(
          `CREATE OR REPLACE TABLE runs AS ${buildRunsTableSql(
            runs.map((r) => ({
              run_id: r.run_id,
              source: r.source,
              updated: r.updated,
              size_bytes: r.size_bytes,
            })),
          )};`,
        );

        // v_features over all cached files, or a typed zero-row view when there
        // are none - so the derived views/tables always exist with the right
        // schema (no placeholder file needed).
        await conn.run(
          files.length > 0
            ? buildFeaturesViewSql(files)
            : buildEmptyFeaturesViewSql(),
        );
        // Creates the v_scenarios + v_steps VIEWS. v_steps is queried on demand
        // for run-detail steps and scenario step-history - never materialized.
        await conn.run(buildScenariosStepsViewsSql());

        // test_ids: one cheap pass over the extracted data.
        await conn.run(
          `CREATE OR REPLACE TABLE test_ids AS ${buildTestIdsSelectSql()};`,
        );

        // scenarios: one row per (run, scenario) with its test_id, minus the
        // heavy steps list (that stays in v_steps). Small enough to hold for the
        // whole window.
        await conn.run(`
          CREATE OR REPLACE TABLE scenarios AS
            SELECT sr.* EXCLUDE (steps), ti.test_id
            FROM v_scenarios sr
            LEFT JOIN test_ids ti USING (run_id, scenario_id);
        `);

        // service_versions: analysis over the stored logs.
        await conn.run(
          `CREATE OR REPLACE TABLE service_versions AS ${buildServiceVersionsSelectSql()};`,
        );
        await conn.run("COMMIT;");
      } catch (err) {
        await conn.run("ROLLBACK;").catch(() => {});
        throw err;
      }
    });
  }

  /**
   * Extract the missing runs in the background (one pass at a time). Their data
   * becomes visible on the next rebuild - the TTL or the warmer - so a cold
   * instance fills in progressively instead of serving nothing.
   */
  private startExtraction(missing: RunInfo[]): void {
    if (this.extraction) return;
    const todo = missing.filter((r) => !this.attempted.has(runKey(r)));
    if (todo.length === 0) return;
    for (const run of todo) this.attempted.add(runKey(run));

    const t0 = Date.now();
    console.log(`[store] extracting ${todo.length} run(s) in the background`);
    this.extraction = this.cache
      .ensureMany(todo)
      .then((files) => {
        console.log(
          `[store] extracted ${files.length}/${todo.length} run(s) in ${Date.now() - t0}ms`,
        );
        // Extracted runs stay invisible until something re-materializes, so drop
        // the TTL instead of making them wait it out: on a cold instance that's
        // the difference between the dashboard filling in as runs land and it
        // sitting empty (with the progress banner stuck) for a whole minute.
        if (files.length > 0) this.materializedAt = 0;
      })
      .catch((err) => {
        console.warn(
          `[store] background extraction failed:`,
          (err as Error)?.message ?? err,
        );
      })
      .finally(() => {
        this.extraction = null;
      });
  }

  /**
   * Load ONE run that isn't in the window, on demand: resolve it in the bucket,
   * extract it if it isn't cached yet, and hand back a relation over just its
   * Parquet. Returns null when no such run exists.
   *
   * Deliberately NOT folded into the model. Adding it to `runs` would leak an
   * ancient run into the dashboard list, the header's date range and - worse -
   * the "previous run" subqueries that drive the run-detail diffs, and it would
   * cost a full rebuild per deep link. Reading its own file through the
   * parameterized builders (buildScenariosSelectSql &co.) costs one file scan and
   * leaves the window a clean boundary. The trade-off is that cross-run
   * comparisons aren't available for such a run: the neighbouring runs aren't
   * loaded either.
   *
   * The extraction is NOT backgrounded - unlike the window's build-up, a deep
   * link has nothing to show until its own report is parsed, so the request waits
   * (~seconds, once per run ever, since the file then stays in the shared cache).
   */
  async outOfWindowRun(runId: string): Promise<OutOfWindowRun | null> {
    if (!isRunIdShaped(runId)) return null;
    const run = await this.source.resolveRun(runId);
    if (!run) return null;
    const file = await this.cache.ensure(run);
    return { run, features: readParquetSql([file]) };
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
