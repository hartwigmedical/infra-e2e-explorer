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
import { useDuckDBContext } from "~/contexts/DuckDBContext";
import { buildE2eViewsSql } from "~/lib/e2e-views";
import { queryE2e } from "~/lib/e2e-data";

interface RunManifestEntry {
  run_id: string;
  file: string;
  source: string;
  updated: string;
  size_bytes: number;
}

export type E2eDataStatus = "loading" | "runs-ready" | "ready" | "error";

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
  /** Number of runs listed in runs.json. */
  runCount: number;
  error: Error | null;
  /** Re-run the full init sequence (stage 1 + stage 2) from scratch. */
  reload: () => void;
  /** Run a one-off SELECT against the shared DuckDB instance, returning plain objects. */
  query: <T = any>(sql: string) => Promise<T[]>;
}

const E2eDataContext = createContext<E2eDataContextValue | null>(null);

/**
 * Owns the one-time materialization of the Cucumber e2e report data into
 * in-memory DuckDB tables, shared by every route via context.
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
 *  - STAGE 1 reads only runs.json (tiny) -> `runs` table. Fast, so the runs
 *    list can paint almost immediately.
 *  - STAGE 2 reads all 60 report files once -> `scenarios` + `steps` tables.
 *    This is the heavy part (274MB of JSON parsed in wasm).
 */
export function E2eDataProvider({ children }: { children: ReactNode }) {
  const { db } = useDuckDBContext();
  const [status, setStatus] = useState<E2eDataStatus>("loading");
  const [runsReady, setRunsReady] = useState(false);
  const [detailsReady, setDetailsReady] = useState(false);
  const [stepsFallback, setStepsFallback] = useState(false);
  const [runCount, setRunCount] = useState(0);
  const [error, setError] = useState<Error | null>(null);

  const startedRef = useRef(false);
  const dbRef = useRef<AsyncDuckDB | null>(null);

  const runInit = useCallback(async (database: AsyncDuckDB) => {
    setStatus("loading");
    setRunsReady(false);
    setDetailsReady(false);
    setStepsFallback(false);
    setError(null);

    const conn = await database.connect();
    try {
      // ---- STAGE 1: fast, runs.json only ----
      const dataBase = window.location.origin + "/data/";
      const manifestRes = await fetch("/data/runs.json");
      if (!manifestRes.ok) {
        throw new Error(
          `Failed to fetch /data/runs.json: ${manifestRes.status} ${manifestRes.statusText}`
        );
      }
      const manifest: RunManifestEntry[] = await manifestRes.json();

      const runsJsonUrl = new URL("runs.json", dataBase).toString();
      const reportUrls = manifest.map((entry) => new URL(entry.file, dataBase).toString());

      // Creating the views is cheap/lazy - no file reads happen until something
      // selects from them.
      const viewsSql = buildE2eViewsSql(runsJsonUrl, reportUrls);
      await conn.query(viewsSql);

      await conn.query(`CREATE OR REPLACE TABLE runs AS SELECT * FROM v_runs;`);

      setRunCount(manifest.length);
      setRunsReady(true);
      setStatus("runs-ready");

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
          stage2Err
        );
        await conn.query(`
          CREATE OR REPLACE TABLE scenarios AS SELECT * EXCLUDE (steps) FROM v_scenarios;
        `);
        setStepsFallback(true);
      }

      setDetailsReady(true);
      setStatus("ready");
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
      setStatus("error");
    } finally {
      await conn.close();
    }
  }, []);

  useEffect(() => {
    if (!db || startedRef.current) return;
    startedRef.current = true;
    dbRef.current = db;
    void runInit(db);
  }, [db, runInit]);

  const reload = useCallback(() => {
    if (dbRef.current) void runInit(dbRef.current);
  }, [runInit]);

  const query = useCallback(
    <T = any,>(sql: string): Promise<T[]> => {
      if (!dbRef.current) return Promise.reject(new Error("DuckDB not ready"));
      return queryE2e<T>(dbRef.current, sql);
    },
    []
  );

  const value: E2eDataContextValue = {
    status,
    runsReady,
    detailsReady,
    stepsFallback,
    runCount,
    error,
    reload,
    query,
  };

  return <E2eDataContext.Provider value={value}>{children}</E2eDataContext.Provider>;
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
export function useE2eQuery<T = any>(sql: string | null, deps: any[]): UseE2eQueryResult<T> {
  const { query, runsReady } = useE2eData();
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
  }, [sql, runsReady, query, ...deps]);

  return { rows, loading, error };
}
