/**
 * SQL for the four non-stored DuckDB views that expose the nested Cucumber
 * JSON e2e reports as clean, flat, queryable tables. Two data sources feed
 * these views (see app/contexts/E2eDataContext.tsx for how the active one is
 * chosen):
 *
 *   - LOCAL mode: runs.json + report files served same-origin from /data.
 *   - API  mode: the live `/api/runs` run list (registered into DuckDB-Wasm's
 *     virtual filesystem via `registerFileText`, see E2eDataContext) plus
 *     each run's signed `cucumberUrl` pointing at storage.googleapis.com.
 *
 * The views themselves don't care which mode produced their inputs - they
 * just take a runs-JSON location and a list of report URLs:
 *
 *   v_runs       - one row per run, derived straight from the run list (no report parsing)
 *   v_features   - one row per (run, feature)
 *   v_scenarios  - one row per (run, scenario) - background elements excluded
 *   v_steps      - one row per (run, scenario, step)
 *   (test_ids)   - one row per (run, scenario) test_id, parsed out of the
 *                  scenario's after-hook text/plain log embedding's `name`
 *                  field (e.g. "Log of test 12345678"). NOT a view: built by
 *                  buildTestIdsSelectSql() (see TEST_ID_ELEMENTS_TYPE) and run
 *                  by E2eDataContext in small file BATCHES into a `test_ids`
 *                  table. Even though the schema reads only the tiny `name`
 *                  (never the embeddings' `data`, which can be a multi-MB base64
 *                  zip blob alongside the log), read_json still PARSES past
 *                  those `data` values in the raw JSON, so a single pass over a
 *                  whole wide window OOMs the wasm heap - batching bounds peak
 *                  parse memory to one batch regardless of window size.
 *
 * These are views, not materialized tables: every query against them re-reads
 * the underlying JSON via DuckDB's `read_json`, so there is nothing to keep in
 * sync when new runs land in the manifest - re-running buildE2eViewsSql() (or
 * just querying again after CREATE VIEW) always reflects the current input.
 *
 * app/contexts/E2eDataContext.tsx creates these views once per session and
 * then materializes `runs`/`scenarios`/`steps`/`test_ids` TABLEs on top of
 * them, so the app never re-reads the underlying JSON on every query (see
 * that file's doc comment for the two-stage materialization strategy).
 *
 * Validated against 60 real report files (public/data, ~277MB total) via the
 * DuckDB CLI before being wired into the browser.
 *
 * v_features uses an EXPLICIT `columns` schema for read_json instead of
 * auto-detection (deviation from the original draft - see buildE2eViewsSql
 * doc comment below for why).
 *
 * Separately, `buildScenarioLogsSql()` below builds a one-off query (NOT a
 * view baked into buildE2eViewsSql) for reading a SINGLE run's full scenario
 * logs on demand - see its own doc comment for why that one does need to
 * decode `data` and is deliberately scoped to one report URL at a time.
 */

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlArrayLiteral(values: string[]): string {
  return `[${values.map(sqlStringLiteral).join(", ")}]`;
}

// Explicit schema for the `elements` field of a Cucumber feature, passed to
// read_json's `columns` option (see buildE2eViewsSql for why). Only the
// fields actually consumed by v_scenarios/v_steps are declared; anything
// else present in the source JSON (e.g. attachment/embedding blobs on hooks,
// which can carry large base64 log dumps and are not needed by any view
// here) is simply never extracted.
const ELEMENTS_TYPE = `STRUCT(
    id VARCHAR,
    name VARCHAR,
    line BIGINT,
    "type" VARCHAR,
    tags STRUCT(name VARCHAR)[],
    start_timestamp VARCHAR,
    before STRUCT(result STRUCT(status VARCHAR, duration BIGINT), match STRUCT(location VARCHAR))[],
    after STRUCT(result STRUCT(status VARCHAR, duration BIGINT), match STRUCT(location VARCHAR))[],
    steps STRUCT(
      keyword VARCHAR,
      name VARCHAR,
      line BIGINT,
      match STRUCT(location VARCHAR, arguments STRUCT(val VARCHAR, "offset" BIGINT)[]),
      result STRUCT(status VARCHAR, duration BIGINT, error_message VARCHAR)
    )[]
  )[]`
  .replace(/\s+/g, " ")
  .trim();

const FEATURES_COLUMNS = `{'uri': 'VARCHAR', 'name': 'VARCHAR', 'keyword': 'VARCHAR', 'tags': 'STRUCT(name VARCHAR)[]', 'elements': '${ELEMENTS_TYPE}'}`;

// Minimal schema for the test_id extraction pass (see v_test_ids below). The
// per-scenario 8-digit test id is embedded right in the NAME of the
// scenario's after-hook text/plain log embedding ("Log of test <8 digits>") -
// step args/data-tables/names all keep the literal "$testId" placeholder, so
// there's no way to get it without embeddings. Rather than adding embeddings
// to ELEMENTS_TYPE above (which would carry them into every row of the
// scenarios/steps tables materialized in E2eDataContext), this schema
// declares ONLY `id`/`type`/`after.embeddings.{mime_type,name}` - deliberately
// omitting `data` entirely, so this never reads (let alone decodes) any
// embedding's base64 payload, including the multi-MB screenshot/video zip
// some scenarios carry alongside the log in the same list. Reading only tiny
// `name` strings for every file is cheap, so - unlike the old data-decoding
// version of this extraction - v_test_ids can be a single view over ALL
// report URLs, no batching required.
const TEST_ID_ELEMENTS_TYPE = `STRUCT(
    id VARCHAR,
    "type" VARCHAR,
    after STRUCT(
      embeddings STRUCT(mime_type VARCHAR, name VARCHAR)[]
    )[]
  )[]`
  .replace(/\s+/g, " ")
  .trim();

const TEST_ID_FEATURES_COLUMNS = `{'elements': '${TEST_ID_ELEMENTS_TYPE}'}`;

// Schema for the on-demand single-run scenario log fetch (see
// buildScenarioLogsSql). Unlike TEST_ID_ELEMENTS_TYPE above, this DOES declare
// `data` because the whole point is to decode the log text - but it's only
// ever queried for one report URL at a time (see that function's doc comment
// for why that keeps it safe).
const SCENARIO_LOG_ELEMENTS_TYPE = `STRUCT(
    id VARCHAR,
    "type" VARCHAR,
    after STRUCT(
      embeddings STRUCT(mime_type VARCHAR, "data" VARCHAR)[]
    )[]
  )[]`
  .replace(/\s+/g, " ")
  .trim();

const SCENARIO_LOG_FEATURES_COLUMNS = `{'elements': '${SCENARIO_LOG_ELEMENTS_TYPE}'}`;

/**
 * Build a SELECT of (scenario_id, log) for a SINGLE run's report file: the
 * fully decoded text/plain after-hook log embedding for every scenario in
 * that one file. Used on demand by the run-detail "Log" button
 * (E2eDataContext.reportUrlByRunId supplies the URL for the run currently
 * being viewed) rather than folded into the startup materialization.
 *
 * This is the one place that still base64-decodes an embedding's `data` -
 * intentionally scoped to ONE report URL per call, so the multi-MB
 * screenshot/video zip embedding some scenarios carry alongside the log is
 * only ever read transiently for a single file, never across a whole window
 * (that was what OOMed the old batched test_id extraction - see
 * TEST_ID_ELEMENTS_TYPE above for why that extraction now avoids `data`
 * entirely instead).
 *
 * list_filter narrows to the text/plain embedding BEFORE from_base64/decode,
 * so the zip is never base64-decoded. NULL-safe: a missing/empty `after` or no
 * text/plain embedding both fall through to a NULL log.
 */
export function buildScenarioLogsSql(reportUrl: string): string {
  const reportUrlArray = sqlArrayLiteral([reportUrl]);
  return `
SELECT e.id AS scenario_id,
       decode(from_base64(
         list_extract(
           list_filter(
             flatten(list_transform(coalesce(e.after, []), h -> coalesce(h.embeddings, []))),
             emb -> emb.mime_type = 'text/plain'
           ),
           1
         )."data"
       )) AS log
FROM read_json(${reportUrlArray}, format = 'array',
               columns = ${SCENARIO_LOG_FEATURES_COLUMNS}, maximum_object_size = 67108864),
     UNNEST(elements) AS t(e)
WHERE e.type = 'scenario'`;
}

/**
 * Build the name-based test_id extraction SELECT for a SUBSET of report URLs -
 * one row per (run, scenario), with the "Log of test <id>" id pulled from the
 * after-hook text/plain embedding's `name`. Reads only tiny `name` strings,
 * never any `data` blob.
 *
 * Callable per-batch (NOT a single view over all URLs) because read_json still
 * PARSES past each file's multi-MB embedding `data` values even when the schema
 * omits them, so reading a whole wide window at once OOMs the wasm heap.
 * E2eDataContext invokes this over small file batches and INSERTs the tiny
 * results into a `test_ids` table, bounding peak parse memory to one batch.
 *
 * nullif('') because regexp_extract returns '' (not NULL) when the embedding
 * name doesn't match, so a scenario whose log name didn't parse becomes NULL
 * (no Test ID shown) rather than an empty-valued row.
 */
export function buildTestIdsSelectSql(reportUrls: string[]): string {
  const reportUrlArray = sqlArrayLiteral(reportUrls);
  return `
SELECT regexp_extract(filename, '([^/?]+)/cucumber[a-z-]*\\.json', 1) AS run_id,
       e.id AS scenario_id,
       nullif(
         regexp_extract(
           list_extract(
             list_filter(
               flatten(list_transform(coalesce(e.after, []), h -> coalesce(h.embeddings, []))),
               emb -> emb.mime_type = 'text/plain'
             ),
             1
           ).name,
           'Log of test ([0-9]+)', 1
         ), ''
       ) AS test_id
FROM read_json(${reportUrlArray}, filename = true, format = 'array',
               columns = ${TEST_ID_FEATURES_COLUMNS}, maximum_object_size = 67108864),
     UNNEST(elements) AS t(e)
WHERE e.type = 'scenario'`;
}

/**
 * Build the full CREATE OR REPLACE VIEW script for the four views.
 *
 * @param runsJsonUrl - location of the run list, readable via DuckDB's
 *   `read_json`. Either an absolute URL to runs.json (LOCAL mode) or the name
 *   of a file registered into duckdb-wasm's virtual filesystem via
 *   `registerFileText` (API mode) - `read_json` doesn't care which.
 * @param reportUrls - absolute URLs to each run's cucumber.json report -
 *   same-origin /data paths in LOCAL mode, signed storage.googleapis.com URLs
 *   in API mode. Order doesn't matter for correctness: run_id is recovered
 *   per-row from the source filename via `filename = true`, not from array
 *   position.
 */
export function buildE2eViewsSql(runsJsonUrl: string, reportUrls: string[]): string {
  const runsJsonLiteral = sqlStringLiteral(runsJsonUrl);
  const reportUrlArray = sqlArrayLiteral(reportUrls);

  return `
-- runs overview straight from the manifest (no report parsing)
CREATE OR REPLACE VIEW v_runs AS
SELECT
  run_id, source, updated, size_bytes,
  strptime(regexp_extract(run_id, '^(\\d{4}-\\d{2}-\\d{2})', 1), '%Y-%m-%d')      AS run_date,
  regexp_extract(run_id, '^\\d{4}-\\d{2}-\\d{2}-(\\d{4})', 1)                       AS run_time,
  CASE WHEN run_id LIKE '%-ok%' THEN 'ok'
       WHEN run_id LIKE '%failed%' THEN 'failed' ELSE 'unknown' END             AS status_token,
  try_cast(regexp_extract(run_id, 'failed-(\\d+)-of-\\d+', 1) AS INTEGER)          AS failed_count,
  try_cast(regexp_extract(run_id, '-of-(\\d+)', 1) AS INTEGER)                    AS total_count,
  (regexp_extract(run_id, '^\\d{4}-\\d{2}-\\d{2}-(\\d{4})', 1) IN ('0000','0100','0200')) AS is_nightly
FROM read_json(${runsJsonLiteral});

-- one row per (run, feature). run_id is recovered from the source filename -
-- a single regex covers both LOCAL paths (".../runs/<id>/cucumber.json") and
-- API-mode signed URLs (".../<id>/cucumber-parallel.json?X-Goog-..."): in
-- both, the run_id is the path segment immediately before "/cucumber*.json".
CREATE OR REPLACE VIEW v_features AS
SELECT regexp_extract(filename, '([^/?]+)/cucumber[a-z-]*\\.json', 1) AS run_id,
       uri AS feature_uri, name AS feature_name, keyword AS feature_keyword,
       tags AS feature_tags, elements
FROM read_json(${reportUrlArray}, filename = true, format = 'array',
               columns = ${FEATURES_COLUMNS}, maximum_object_size = 67108864);

-- one row per (run, scenario). Background elements (type = 'background') are excluded.
CREATE OR REPLACE VIEW v_scenarios AS
WITH scen AS (
  SELECT f.run_id, f.feature_uri, f.feature_name,
         e.id AS scenario_id, e.name AS scenario_name, e.tags AS tags,
         try_cast(e.start_timestamp AS TIMESTAMP) AS started_at,
         e.steps AS steps, e.before AS before_hooks, e.after AS after_hooks,
         row_number() OVER (PARTITION BY f.run_id, f.feature_uri ORDER BY e.line) AS ordinal
  FROM v_features f, UNNEST(f.elements) AS t(e)
  WHERE e.type = 'scenario'
)
SELECT run_id, feature_uri, feature_name, scenario_id, scenario_name, ordinal, started_at,
  list_transform(tags, x -> x.name) AS tag_names,
  coalesce(list_sum(list_transform(steps, s -> s.result.duration)), 0) / 1e9 AS duration_s,
  CASE
    WHEN list_contains(list_transform(steps, s -> s.result.status), 'failed')
      OR list_contains(list_transform(steps, s -> s.result.status), 'ambiguous')
      OR len(list_filter(coalesce(before_hooks, []), h -> h.result.status = 'failed')) > 0
      OR len(list_filter(coalesce(after_hooks, []),  h -> h.result.status = 'failed')) > 0
      THEN 'failed'
    WHEN list_contains(list_transform(steps, s -> s.result.status), 'skipped')
      OR list_contains(list_transform(steps, s -> s.result.status), 'pending')
      OR list_contains(list_transform(steps, s -> s.result.status), 'undefined')
      THEN 'skipped'
    ELSE 'passed'
  END AS status,
  steps
FROM scen;

-- (test_id extraction is NOT a view here - read_json parses past the multi-MB
-- embedding data blobs, so E2eDataContext runs buildTestIdsSelectSql() in small
-- file batches into a test_ids table to bound peak memory. See that function.)

-- one row per (run, scenario, step)
CREATE OR REPLACE VIEW v_steps AS
SELECT sc.run_id, sc.feature_uri, sc.scenario_id, sc.scenario_name,
  trim(s.keyword) || ' ' || s.name AS step_label, s.name AS step_name, trim(s.keyword) AS step_keyword,
  row_number() OVER (PARTITION BY sc.run_id, sc.scenario_id ORDER BY s.line) AS step_ordinal,
  s.result.status AS status,
  s.result.duration / 1e9 AS duration_s,
  (s.result.error_message IS NOT NULL) AS has_error,
  left(s.result.error_message, 2000) AS error_message,
  s.match.location AS glue_location
FROM v_scenarios sc, UNNEST(sc.steps) AS t(s);
`;
}
