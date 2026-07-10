import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { format, subDays } from "date-fns";
import { useDuckDBContext } from "~/contexts/DuckDBContext";
import { buildE2eViewsSql } from "~/lib/e2e-views";
import { queryE2e } from "~/lib/e2e-data";

// ---- LOCAL mode: the existing /data/runs.json manifest shape ----
interface LocalRunManifestEntry {
  run_id: string;
  file: string;
  source: string;
  updated: string;
  size_bytes: number;
}

// ---- API mode: GET /api/runs response shape (see server/index.ts) ----
interface ApiRun {
  run_id: string;
  source: string;
  size_bytes: number | null;
  updated: string | null;
  /** Signed GCS URL, or null when V4 signing isn't configured (see server). */
  cucumberUrl: string | null;
}

interface ApiRunsResponse {
  total: number;
  limit?: number;
  offset?: number;
  /** Echoed back when the request included `?since=` (see server/index.ts). */
  since?: string;
  runs: ApiRun[];
  /** Present when signed-URL generation failed for at least one run. */
  warning?: string;
}

/** Rolling-window presets (widest last), for both API and LOCAL mode. The
 *  default is the past week (fast to load); `loadMore` steps to the next wider
 *  window. */
export const WINDOW_STEPS: { label: string; days: number | null }[] = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 3 months", days: 90 },
  { label: "Last year", days: 365 },
  { label: "All time", days: null },
];
export const DEFAULT_WINDOW_INDEX = 0;

/** `since` cutoff (YYYY-MM-DD) for a given window preset. "all time" (days=null)
 *  uses a far-past date so the server's `since` path still returns everything. */
function sinceCutoff(windowIndex: number): string {
  const days = WINDOW_STEPS[windowIndex]?.days ?? null;
  if (days == null) return "2000-01-01";
  return format(subDays(new Date(), days), "yyyy-MM-dd");
}

/**
 * Try the live backend: GET /api/runs?since=<cutoff>. Resolves to the parsed
 * response only when it's actually usable as a live data source - i.e. it
 * returned 200, `runs` is non-empty, AND at least one run has a non-null
 * `cucumberUrl` (report can actually be fetched). Resolves to null on any
 * network error, non-2xx response, empty run list, or an all-null-cucumberUrl
 * response (the expected local outcome when V4 signing isn't configured -
 * see the top-level warning field) - all of which mean "fall back to LOCAL".
 */
async function tryFetchApiRuns(since: string): Promise<ApiRunsResponse | null> {
  try {
    const res = await fetch(`/api/runs?since=${since}`);
    if (!res.ok) return null;
    const json = (await res.json()) as ApiRunsResponse;
    if (!Array.isArray(json.runs) || json.runs.length === 0) return null;
    const hasUsableReport = json.runs.some(
      (r) => typeof r.cucumberUrl === "string" && r.cucumberUrl.length > 0,
    );
    if (!hasUsableReport) return null;
    return json;
  } catch {
    return null;
  }
}

export type E2eDataStatus = "loading" | "runs-ready" | "ready" | "error";
export type E2eDataSource = "api" | "local";

export interface E2eDataContextValue {
  /** Coarse overall status: 'loading' (nothing yet) -> 'runs-ready' (stage 1 done)
   *  -> 'ready' (stage 2 done too). 'error' if either stage failed. */
  status: E2eDataStatus;
  /** True once the `runs` table exists (fast - runs.json only, no report parsing). */
  runsReady: boolean;
  /** True once `scenarios` (and, unless the wasm-OOM fallback kicked in, `steps`)
   *  exist - i.e. every report file has been read exactly once. */
  detailsReady: boolean;
  /** True if stage 2 hit a wasm OOM and fell back to scenario-only materialization
   *  (no global `steps` table). See the STAGE 2 comment in E2eDataProvider. */
  stepsFallback: boolean;
  /** Which data source is active, once known (null until stage 1 resolves it).
   *  'api' = live GET /api/runs + signed GCS URLs. 'local' = /data/runs.json,
   *  used whenever the API is unreachable, empty, or every cucumberUrl is null
   *  (e.g. signing not configured - the expected local dev outcome today). */
  dataSource: E2eDataSource | null;
  /** Number of runs currently loaded into the `runs` table (i.e. runs whose
   *  date falls within the current window preset). */
  runCount: number;
  /** Total runs available at the source, regardless of the current window.
   *  In API mode this is the grand total across the whole bucket (see
   *  server/index.ts). In LOCAL mode this is the full synced manifest count.
   *  Compare against `runCount` (via `hasMore`) to tell whether older runs
   *  exist beyond the current window. */
  totalRuns: number;
  /** Human label for the current window preset (e.g. "Last 7 days"); widens one
   *  step per `loadMore()` call. See WINDOW_STEPS. */
  windowLabel: string;
  /** Label of the NEXT wider preset (e.g. "Last 30 days" while `windowLabel`
   *  is "Last 7 days"), or null once the widest preset ("All time") is
   *  already active. Lets callers (e.g. DateRangeControl) label a "Load more"
   *  action and detect when everything is loaded. */
  nextWindowLabel: string | null;
  /** True while a `loadMore` re-materialization is in flight. */
  loadingMore: boolean;
  /** Increments each time the tables are rebuilt in place (soft load-more), so
   *  useE2eQuery consumers re-run and pick up the wider window. */
  dataVersion: number;
  /** True while there are runs older than the current window (`runCount <
   *  totalRuns`) - i.e. whether "Load more" should be offered. */
  hasMore: boolean;
  /** Widen the window to the next preset (recomputing the `since` cutoff) and
   *  re-materialize every table. Works in both API and LOCAL mode. No-op once
   *  `hasMore` is false or the widest preset is already reached. */
  loadMore: () => void;
  error: Error | null;
  /** Re-run the full init sequence (stage 1 + stage 2) from scratch, keeping
   *  the current window size. */
  reload: () => void;
  /** Run a one-off SELECT against the shared DuckDB instance, returning plain objects. */
  query: <T = any>(sql: string) => Promise<T[]>;
}

const E2eDataContext = createContext<E2eDataContextValue | null>(null);

/**
 * Owns data-source resolution AND the one-time materialization of the
 * Cucumber e2e report data into in-memory DuckDB tables, shared by every
 * route via context.
 *
 * Data source resolution (start of every runInit): try the live backend
 * first (`tryFetchApiRuns`) and use it - API mode - only if it comes back
 * with a non-empty run list where at least one run has a usable (non-null)
 * `cucumberUrl`. Otherwise (unreachable, empty, or every cucumberUrl is null
 * - e.g. V4 signing isn't configured, the expected local dev situation today)
 * fall back to LOCAL mode: the original /data/runs.json + same-origin report
 * files, unchanged. Either way, downstream (buildE2eViewsSql, the two-stage
 * materialization below, every route) is identical - see e2e-views.ts's doc
 * comment for how the two sources are unified into the same `v_runs`/
 * `v_features` inputs.
 *
 * Why materialize instead of just querying the v_* views directly: the views
 * in e2e-views.ts re-read the underlying JSON (274MB across 60 files) via
 * read_json on *every* query. That's fine for a single debug query, but the
 * dashboard fires several queries per render - re-reading all that JSON each
 * time is far too slow. So we read every file exactly once, at startup, into
 * real tables (`runs`, `scenarios`, `steps`), and every subsequent query in
 * the app hits those tables instead of the views.
 *
 * Two stages so the UI isn't blocked on the slow part:
 *  - STAGE 1 resolves the data source and reads only the (tiny) run list ->
 *    `runs` table. Fast, so the runs list can paint almost immediately.
 *  - STAGE 2 reads every report file once -> `scenarios` + `steps` tables.
 *    This is the heavy part (hundreds of MB of JSON parsed in wasm).
 */
export function E2eDataProvider({ children }: { children: ReactNode }) {
  const { db } = useDuckDBContext();
  const [status, setStatus] = useState<E2eDataStatus>("loading");
  const [runsReady, setRunsReady] = useState(false);
  const [detailsReady, setDetailsReady] = useState(false);
  const [stepsFallback, setStepsFallback] = useState(false);
  const [dataSource, setDataSource] = useState<E2eDataSource | null>(null);
  const [runCount, setRunCount] = useState(0);
  const [totalRuns, setTotalRuns] = useState(0);
  const [windowIndex, setWindowIndex] = useState(DEFAULT_WINDOW_INDEX);
  const [loadingMore, setLoadingMore] = useState(false);
  // Bumped whenever the tables are rebuilt in place (soft load-more) so mounted
  // useE2eQuery consumers re-run without runsReady/detailsReady flipping (which
  // would blank them). See loadMore + useE2eQuery.
  const [dataVersion, setDataVersion] = useState(0);
  const [error, setError] = useState<Error | null>(null);

  const startedRef = useRef(false);
  const dbRef = useRef<AsyncDuckDB | null>(null);
  // Current window preset index (into WINDOW_STEPS). Persists across `reload()`
  // calls so retrying doesn't silently shrink what `loadMore` had grown it to.
  // Used to compute the `since` cutoff in both API and LOCAL mode.
  const windowIndexRef = useRef(DEFAULT_WINDOW_INDEX);

  const runInit = useCallback(
    async (
      database: AsyncDuckDB,
      windowIndexArg?: number,
      opts?: { soft?: boolean },
    ) => {
      // soft = load-more: rebuild the tables for a wider window WITHOUT blanking
      // the UI. Leave status/runsReady/detailsReady + counts/label as-is (so
      // every useE2eQuery keeps its current rows), rebuild in place, then set the
      // new counts/label + bump dataVersion at the end for a seamless swap-in.
      const soft = opts?.soft ?? false;
      const prevWindowIndex = windowIndexRef.current;
      if (windowIndexArg != null) windowIndexRef.current = windowIndexArg;
      if (!soft) {
        setStatus("loading");
        setRunsReady(false);
        setDetailsReady(false);
        setStepsFallback(false);
        setError(null);
        setWindowIndex(windowIndexRef.current);
      }

      const since = sinceCutoff(windowIndexRef.current);

      let nextDataSource: E2eDataSource = "local";
      let nextRunCount = 0;
      let nextTotal = 0;

      const conn = await database.connect();
      try {
        // ---- STAGE 1: fast, resolve the data source + run list ----
        let runsJsonUrl: string;
        let reportUrls: string[];

        const apiResponse = await tryFetchApiRuns(since);
        if (apiResponse) {
          // API mode: register the run list as a virtual file so it can be
          // read via read_json exactly like runs.json is in LOCAL mode below -
          // buildE2eViewsSql doesn't need to know the difference. The server
          // already applied `since`, so apiResponse.runs IS the current window.
          await database.registerFileText(
            "e2e_runs.json",
            JSON.stringify(apiResponse.runs),
          );
          runsJsonUrl = "e2e_runs.json";
          reportUrls = apiResponse.runs
            .map((r) => r.cucumberUrl)
            .filter((u): u is string => typeof u === "string" && u.length > 0);

          nextDataSource = "api";
          nextRunCount = apiResponse.runs.length;
          nextTotal = apiResponse.total;
        } else {
          // LOCAL mode: fetch the full synced manifest (unchanged), then filter
          // client-side to the current rolling window so the same month-window
          // + load-more UX applies as in API mode.
          const dataBase = window.location.origin + "/data/";
          const manifestRes = await fetch("/data/runs.json");
          if (!manifestRes.ok) {
            throw new Error(
              `Failed to fetch /data/runs.json: ${manifestRes.status} ${manifestRes.statusText}`,
            );
          }
          const fullManifest: LocalRunManifestEntry[] =
            await manifestRes.json();
          const manifest = fullManifest.filter(
            (entry) => entry.run_id.slice(0, 10) >= since,
          );

          // Register the filtered manifest as a virtual file (same pattern as
          // API mode above) instead of pointing read_json at runs.json directly,
          // so v_runs only sees runs inside the current window.
          await database.registerFileText(
            "e2e_runs_local.json",
            JSON.stringify(manifest),
          );
          runsJsonUrl = "e2e_runs_local.json";
          reportUrls = manifest.map((entry) =>
            new URL(entry.file, dataBase).toString(),
          );

          nextDataSource = "local";
          nextRunCount = manifest.length;
          nextTotal = fullManifest.length;
        }

        // Creating the views is cheap/lazy - no file reads happen until something
        // selects from them.
        const viewsSql = buildE2eViewsSql(runsJsonUrl, reportUrls);
        await conn.query(viewsSql);

        await conn.query(
          `CREATE OR REPLACE TABLE runs AS SELECT * FROM v_runs;`,
        );

        if (!soft) {
          setDataSource(nextDataSource);
          setRunCount(nextRunCount);
          setTotalRuns(nextTotal);
          setRunsReady(true);
          setStatus("runs-ready");
        }

        // ---- STAGE 2: heavy, reads all report files exactly once ----
        try {
          await conn.query(`
          CREATE OR REPLACE TABLE scenarios_raw AS SELECT * FROM v_scenarios;
          CREATE OR REPLACE TABLE steps AS
            SELECT sc.run_id, sc.feature_uri, sc.scenario_id, sc.scenario_name,
              trim(s.keyword)||' '||s.name AS step_label, s.name AS step_name, trim(s.keyword) AS step_keyword,
              row_number() OVER (PARTITION BY sc.run_id, sc.scenario_id ORDER BY s.line) AS step_ordinal,
              s.result.status AS status, s.result.duration/1e9 AS duration_s,
              (s.result.error_message IS NOT NULL) AS has_error,
              left(s.result.error_message, 2000) AS error_message, s.match.location AS glue_location
            FROM scenarios_raw sc, UNNEST(sc.steps) AS t(s);
          CREATE OR REPLACE TABLE scenarios AS SELECT * EXCLUDE (steps) FROM scenarios_raw;
          DROP TABLE scenarios_raw;
        `);
        } catch (stage2Err) {
          // FALLBACK: if materializing the full steps table OOMs the wasm heap,
          // still materialize `scenarios` on its own (smaller - no steps list,
          // no cross join) so the dashboard's per-run pass/fail/skip counts and
          // the sparkline still work. Step-level history (Phase 3) would then
          // read a single run's report file on demand instead of hitting a
          // global `steps` table.
          console.warn(
            "[E2eDataProvider] STAGE 2 full materialization (scenarios + steps) failed, " +
              "falling back to scenarios-only:",
            stage2Err,
          );
          await conn.query(`
          CREATE OR REPLACE TABLE scenarios AS SELECT * EXCLUDE (steps) FROM v_scenarios;
        `);
          setStepsFallback(true);
        }

        if (soft) {
          // Soft (load-more) done: publish the wider window's source/counts/label
          // and bump dataVersion so consumers re-query and swap in the new rows
          // in place (no blanking).
          setDataSource(nextDataSource);
          setRunCount(nextRunCount);
          setTotalRuns(nextTotal);
          setWindowIndex(windowIndexRef.current);
          setDataVersion((v) => v + 1);
        } else {
          setDetailsReady(true);
          setStatus("ready");
        }
      } catch (e) {
        if (soft) {
          // Load-more failed: keep the current data on screen untouched; just
          // undo the window bump so a retry starts from the right place.
          windowIndexRef.current = prevWindowIndex;
          console.warn(
            "[E2eDataProvider] load-more failed; keeping current data:",
            e,
          );
        } else {
          setError(e instanceof Error ? e : new Error(String(e)));
          setStatus("error");
        }
      } finally {
        await conn.close();
      }
    },
    [],
  );

  useEffect(() => {
    if (!db || startedRef.current) return;
    startedRef.current = true;
    dbRef.current = db;
    void runInit(db);
  }, [db, runInit]);

  const reload = useCallback(() => {
    if (dbRef.current) void runInit(dbRef.current);
  }, [runInit]);

  const hasMore = runCount < totalRuns;

  // Widen the rolling window to the next preset and re-run the full init
  // sequence against the recomputed `since` cutoff. Works the same way in both
  // API and LOCAL mode (see runInit above). A full re-materialize is simple and
  // correct; see the module doc comment for why that's an acceptable tradeoff
  // here. No-op once every available run is loaded or the widest preset is hit.
  const loadMore = useCallback(() => {
    if (!dbRef.current || !hasMore) return;
    const nextIndex = Math.min(
      windowIndexRef.current + 1,
      WINDOW_STEPS.length - 1,
    );
    if (nextIndex === windowIndexRef.current) return;
    setLoadingMore(true);
    void runInit(dbRef.current, nextIndex, { soft: true }).finally(() =>
      setLoadingMore(false),
    );
  }, [runInit, hasMore]);

  const query = useCallback(<T = any,>(sql: string): Promise<T[]> => {
    if (!dbRef.current) return Promise.reject(new Error("DuckDB not ready"));
    return queryE2e<T>(dbRef.current, sql);
  }, []);

  const value: E2eDataContextValue = {
    status,
    runsReady,
    detailsReady,
    stepsFallback,
    dataSource,
    runCount,
    totalRuns,
    windowLabel: WINDOW_STEPS[windowIndex]?.label ?? "",
    nextWindowLabel:
      windowIndex < WINDOW_STEPS.length - 1
        ? WINDOW_STEPS[windowIndex + 1].label
        : null,
    loadingMore,
    dataVersion,
    hasMore,
    loadMore,
    error,
    reload,
    query,
  };

  return (
    <E2eDataContext.Provider value={value}>{children}</E2eDataContext.Provider>
  );
}

export function useE2eData(): E2eDataContextValue {
  const ctx = useContext(E2eDataContext);
  if (!ctx) throw new Error("useE2eData must be used within E2eDataProvider");
  return ctx;
}

export interface UseE2eQueryResult<T> {
  rows: T[];
  loading: boolean;
  error: Error | null;
}

/**
 * Run a SELECT against the shared, materialized e2e tables (runs/scenarios/steps).
 *
 * Skips (returns `{ rows: [], loading: false, error: null }` without querying)
 * when `sql` is null, or before `runsReady` - i.e. before the `runs` table even
 * exists. Callers whose query depends on stage-2 tables (`scenarios`/`steps`)
 * are responsible for passing `sql={detailsReady ? "..." : null}` themselves,
 * since this hook has no way to know which tables a given query string touches.
 */
export function useE2eQuery<T = any>(
  sql: string | null,
  deps: any[],
): UseE2eQueryResult<T> {
  const { query, runsReady, dataVersion } = useE2eData();
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!sql || !runsReady) {
      setRows([]);
      setLoading(false);
      setError(null);
      return;
    }

    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);

    query<T>(sql)
      .then((result) => {
        if (requestIdRef.current !== requestId) return; // stale
        setRows(result);
        setLoading(false);
      })
      .catch((e) => {
        if (requestIdRef.current !== requestId) return; // stale
        setError(e instanceof Error ? e : new Error(String(e)));
        setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sql, runsReady, dataVersion, query, ...deps]);

  return { rows, loading, error };
}
