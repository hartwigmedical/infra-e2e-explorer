/**
 * SQL for exposing the nested Cucumber JSON e2e reports as clean, flat,
 * queryable tables/views in DuckDB. Every statement the server-side data layer
 * runs is built here, so this file is the single source of truth for the schema
 * and the analysis. See server/data/store.ts for the orchestration.
 *
 * Loading strategy:
 *
 *   1. The `runs` table is built from the run list alone (buildRunsTableSql, an
 *      in-memory VALUES list) - no report parsing.
 *   2. Each run's raw cucumber.json is parsed EXACTLY ONCE into a compact
 *      Parquet (buildSlimSelectSql): the feature/scenario/step structure with
 *      the embeddings' multi-MB base64 `data` blobs stripped (they're 90%+ of a
 *      report's bytes). We keep the tiny embedding `name`/`mime_type` (for
 *      test_id extraction) AND the decoded text/plain scenario `log` (see
 *      SLIM_ELEMENTS_TYPE). That Parquet is cached on disk, one file per run,
 *      keyed by run_id (see server/data/cache.ts), so it survives restarts and
 *      is shared by every request.
 *   3. v_features reads those Parquet files (buildFeaturesViewSql), and
 *      v_scenarios / v_steps / test_ids / service_versions all run over
 *      v_features - i.e. over the cheap extracted data, never the raw JSON
 *      again. The store materialises `scenarios` / `test_ids` /
 *      `service_versions` as tables; v_steps stays a VIEW and is queried on
 *      demand (steps are ~90% of the rows and only ever needed for one run or
 *      one scenario at a time).
 *
 * Because the log lives in the cached Parquet, nothing re-reads the raw JSON
 * once a run is cached: the run-detail Log button reads it from v_features
 * (see app/routes/runs.$runId.logs.tsx) and the deployment panel derives service
 * versions from it (buildServiceVersionsSelectSql).
 *
 * Why cache the extracted structure (rather than the final scenarios/steps
 * tables): the expensive step is parsing the huge raw JSON; the analysis SQL
 * over the extracted structure is cheap. So changing status/background/test_id/
 * service-version logic (or adding a column derived from fields we already
 * capture) needs NO cache invalidation - only changing the *extraction* does,
 * which is what CACHE_VERSION below is for.
 *
 * read_json uses an EXPLICIT `columns` schema rather than auto-detection:
 * explicit typing sidesteps schema drift between report eras (and bounds parse
 * memory). Extraction runs one report at a time, so peak parse memory stays
 * bounded to a single report even though the read materialises that file's
 * base64 `data` transiently to decode the log (buildSlimSelectSql drops it
 * before storing).
 *
 * Validated against real report files (public/data) via the DuckDB CLI.
 */

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlArrayLiteral(values: string[]): string {
  return `[${values.map(sqlStringLiteral).join(", ")}]`;
}

// Explicit schema for the `elements` field of a Cucumber feature. Two shapes,
// because we decode each scenario's log at extraction time but never store the
// base64 blobs it lives among:
//
//  - SLIM_ELEMENTS_TYPE is what we STORE (one element per scenario/background):
//    the structure v_scenarios / v_steps / test_id extraction consume, PLUS a
//    decoded `log` string per element (the scenario's text/plain after-hook
//    log). Embeddings keep only the tiny mime_type/name (the test id is parsed
//    from the embedding NAME "Log of test <8 digits>"); the multi-MB base64
//    `data` screenshot/video/log blobs are NOT stored.
//
//  - SLIM_ELEMENTS_READ_TYPE is what read_json PARSES from the raw report: the
//    same source shape but WITHOUT the derived `log` and WITH the after
//    embeddings' base64 `data`, which buildSlimSelectSql decodes into `log` and
//    then drops. So those blobs are read transiently (one report at a time, so
//    parse memory stays bounded) but never land in the cached Parquet.
//
// Storing the decoded log is what lets the run-detail Log button and the
// service-versions extraction read from the cached Parquet - so nothing
// re-fetches the raw JSON once a run is cached (see the logs resource route and
// buildServiceVersionsSelectSql).
const SLIM_ELEMENTS_TYPE = `STRUCT(
    id VARCHAR,
    name VARCHAR,
    line BIGINT,
    "type" VARCHAR,
    tags STRUCT(name VARCHAR)[],
    start_timestamp VARCHAR,
    before STRUCT(result STRUCT(status VARCHAR, duration BIGINT), match STRUCT(location VARCHAR))[],
    after STRUCT(
      result STRUCT(status VARCHAR, duration BIGINT),
      match STRUCT(location VARCHAR),
      embeddings STRUCT(mime_type VARCHAR, name VARCHAR)[]
    )[],
    steps STRUCT(
      keyword VARCHAR,
      name VARCHAR,
      line BIGINT,
      match STRUCT(location VARCHAR, arguments STRUCT(val VARCHAR, "offset" BIGINT)[]),
      result STRUCT(status VARCHAR, duration BIGINT, error_message VARCHAR)
    )[],
    log VARCHAR
  )[]`
  .replace(/\s+/g, " ")
  .trim();

// The raw-report read type: SLIM_ELEMENTS_TYPE's SOURCE shape - no derived
// `log`, but WITH the after embeddings' base64 `data` (needed to decode the
// log). buildSlimSelectSql rebuilds each element into SLIM_ELEMENTS_TYPE:
// decoding `log` from the text/plain embedding and dropping every `data`.
const SLIM_ELEMENTS_READ_TYPE = `STRUCT(
    id VARCHAR,
    name VARCHAR,
    line BIGINT,
    "type" VARCHAR,
    tags STRUCT(name VARCHAR)[],
    start_timestamp VARCHAR,
    before STRUCT(result STRUCT(status VARCHAR, duration BIGINT), match STRUCT(location VARCHAR))[],
    after STRUCT(
      result STRUCT(status VARCHAR, duration BIGINT),
      match STRUCT(location VARCHAR),
      embeddings STRUCT(mime_type VARCHAR, name VARCHAR, "data" VARCHAR)[]
    )[],
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

const SLIM_FEATURES_COLUMNS = `{'uri': 'VARCHAR', 'name': 'VARCHAR', 'keyword': 'VARCHAR', 'tags': 'STRUCT(name VARCHAR)[]', 'elements': '${SLIM_ELEMENTS_READ_TYPE}'}`;

// Rebuild each raw element (SLIM_ELEMENTS_READ_TYPE) into the stored shape
// (SLIM_ELEMENTS_TYPE): copy the blob-free fields as-is, rebuild `after` to keep
// only the embeddings' mime_type/name (dropping `data`), and add the decoded
// text/plain log as `log`. list_filter narrows to the text/plain embedding
// BEFORE from_base64, so the zip blob is
// never decoded, and NULL-safe (no `after`/no text/plain embedding -> NULL log).
const SLIM_ELEMENTS_REBUILD = `list_transform(elements, e -> struct_pack(
    id := e.id,
    name := e.name,
    line := e.line,
    "type" := e."type",
    tags := e.tags,
    start_timestamp := e.start_timestamp,
    before := e.before,
    after := list_transform(coalesce(e.after, []), h -> struct_pack(
      result := h.result,
      match := h.match,
      embeddings := list_transform(coalesce(h.embeddings, []), b -> struct_pack(mime_type := b.mime_type, name := b.name))
    )),
    steps := e.steps,
    log := decode(from_base64(
      list_extract(
        list_filter(
          flatten(list_transform(coalesce(e.after, []), h -> coalesce(h.embeddings, []))),
          emb -> emb.mime_type = 'text/plain'
        ),
        1
      )."data"
    ))
  ))`
  .replace(/\s+/g, " ")
  .trim();

/**
 * Cache version. BUMP THIS whenever you change the EXTRACTION logic - i.e. what
 * or how we store in the per-run Parquet (SLIM_FEATURES_COLUMNS,
 * SLIM_ELEMENTS_READ_TYPE, SLIM_ELEMENTS_REBUILD, SLIM_ELEMENTS_TYPE, or
 * buildSlimSelectSql). Cached files live under a `<CACHE_VERSION>/` directory
 * (see server/data/cache.ts), so bumping this makes every run re-extract into a
 * fresh dir and the old one is simply never read again.
 *
 * You do NOT need to bump for changes to the ANALYSIS SQL that runs OVER the
 * cached data (status/background/test-id/service-version logic, the
 * scenarios/steps derivation) - that re-runs against the cache every rebuild.
 */
export const CACHE_VERSION = "1";

/** One entry of the run list, used to build the `runs` table in memory. */
export interface RunListEntry {
  run_id: string;
  source: string;
  updated: string | null;
  size_bytes: number | null;
}

/**
 * Build a SELECT that produces the `runs` table (with the derived
 * date/time/status/nightly columns) directly from an in-memory VALUES list - no
 * runs.json round-trip. Native DuckDB has no virtual FS, so this replaces the
 * old read_json(file) path. An empty list yields a correctly-typed zero-row
 * result (a single NULL row filtered out) so the table always has the right
 * schema.
 */
export function buildRunsTableSql(runs: RunListEntry[]): string {
  const rows =
    runs.length > 0
      ? runs
          .map(
            (r) =>
              `(${sqlStringLiteral(r.run_id)}, ${sqlStringLiteral(r.source)}, ` +
              `${r.updated == null ? "NULL" : sqlStringLiteral(r.updated)}, ` +
              `${r.size_bytes == null ? "NULL" : r.size_bytes})`,
          )
          .join(",\n    ")
      : "(CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR), CAST(NULL AS VARCHAR), CAST(NULL AS BIGINT))";
  const emptyFilter = runs.length > 0 ? "" : "\nWHERE false";
  return `
SELECT
  run_id, source, updated, size_bytes,
  strptime(regexp_extract(run_id, '^(\\d{4}-\\d{2}-\\d{2})', 1), '%Y-%m-%d')      AS run_date,
  regexp_extract(run_id, '^\\d{4}-\\d{2}-\\d{2}-(\\d{4})', 1)                       AS run_time,
  CASE WHEN run_id LIKE '%-ok%' THEN 'ok'
       WHEN run_id LIKE '%failed%' THEN 'failed' ELSE 'unknown' END             AS status_token,
  try_cast(regexp_extract(run_id, 'failed-(\\d+)-of-\\d+', 1) AS INTEGER)          AS failed_count,
  try_cast(regexp_extract(run_id, '-of-(\\d+)', 1) AS INTEGER)                    AS total_count,
  (regexp_extract(run_id, '^\\d{4}-\\d{2}-\\d{2}-(\\d{4})', 1) IN ('0000','0100','0200')) AS is_nightly
FROM (VALUES
    ${rows}
) AS t(run_id, source, updated, size_bytes)${emptyFilter}`;
}

/**
 * Build the SELECT that extracts ONE run's feature structure from its raw
 * cucumber.json, tagging every row with the known run_id. The cache wraps this
 * in `COPY (...) TO '<run_id>.parquet' (FORMAT parquet)` - one file at a time,
 * so read_json's parse memory is bounded to a single report even though it must
 * parse past that file's base64 `data` blobs. SLIM_ELEMENTS_REBUILD decodes the
 * text/plain log into `log` and drops every `data`, so those blobs are read
 * transiently but never stored.
 *
 * @param reportUrl - absolute URL to the run's raw report: a same-origin
 *   /data/.../cucumber.json path (LOCAL) or a signed storage.googleapis.com URL
 *   (API mode).
 * @param runId - the run this report belongs to; injected as a literal column
 *   so the cached Parquet is self-describing regardless of the source path.
 */
export function buildSlimSelectSql(reportUrl: string, runId: string): string {
  const reportUrlArray = sqlArrayLiteral([reportUrl]);
  return `
SELECT ${sqlStringLiteral(runId)} AS run_id,
       uri AS feature_uri, name AS feature_name, keyword AS feature_keyword, tags AS feature_tags,
       ${SLIM_ELEMENTS_REBUILD} AS elements
FROM read_json(${reportUrlArray}, format = 'array',
               columns = ${SLIM_FEATURES_COLUMNS}, maximum_object_size = 67108864)`;
}

/**
 * A zero-row SELECT with the exact cached-Parquet schema. Used as v_features
 * itself when there are no cached files at all (see buildEmptyFeaturesViewSql),
 * so the derived views/tables still exist with the right columns instead of
 * read_parquet erroring on an empty file list.
 */
export function buildEmptySlimSelectSql(): string {
  return `
SELECT
  CAST(NULL AS VARCHAR) AS run_id,
  CAST(NULL AS VARCHAR) AS feature_uri,
  CAST(NULL AS VARCHAR) AS feature_name,
  CAST(NULL AS VARCHAR) AS feature_keyword,
  CAST(NULL AS STRUCT(name VARCHAR)[]) AS feature_tags,
  CAST(NULL AS ${SLIM_ELEMENTS_TYPE}) AS elements
WHERE false`;
}

/** `read_parquet([...])` over a list of on-disk Parquet paths. */
export function readParquetSql(parquetPaths: string[]): string {
  return `read_parquet(${sqlArrayLiteral(parquetPaths)})`;
}

/**
 * Build CREATE OR REPLACE VIEW v_features over the given per-run slim-Parquet
 * files. One row per (run, feature); run_id is stored in the Parquet by
 * buildSlimSelectSql.
 */
export function buildFeaturesViewSql(parquetPaths: string[]): string {
  return `
CREATE OR REPLACE VIEW v_features AS
SELECT run_id, feature_uri, feature_name, feature_keyword, feature_tags, elements
FROM ${readParquetSql(parquetPaths)};`;
}

/** v_features with no files at all: a typed zero-row view (no placeholder file
 *  needed), so the derived views/tables still exist with the right schema. */
export function buildEmptyFeaturesViewSql(): string {
  return `CREATE OR REPLACE VIEW v_features AS ${buildEmptySlimSelectSql()};`;
}

/**
 * The v_scenarios SELECT, parameterized by the features source relation (a view
 * name like `v_features`, or an inline `read_parquet([...])` for one run). One
 * row per (run, scenario).
 *
 * A feature's Background runs as a SEPARATE 'background' element emitted
 * immediately before each scenario; we fold its steps into that scenario -
 * tagged is_background = true and (via their lower line numbers, which sort
 * first in v_steps) ordered ahead of the scenario's own steps - so duration_s,
 * status, and the step list all account for setup. A failed background step
 * therefore correctly makes the scenario 'failed'.
 *
 * Pairing is by ARRAY ADJACENCY, not line: every emitted background element
 * carries the SAME line and a NULL id, so we zip each element with its 1-based
 * position (elem_idx) and join each scenario to the element at elem_idx - 1 when
 * that is a background.
 */
export function buildScenariosSelectSql(featuresRelation: string): string {
  return `
WITH elems AS (
  SELECT run_id, feature_uri, feature_name, elem_idx,
         e.type AS elem_type, e.id AS elem_id, e.name AS elem_name, e.line AS elem_line,
         e.tags AS tags, e.start_timestamp AS start_timestamp,
         e.steps AS steps, e.before AS before_hooks, e.after AS after_hooks
  FROM (
    SELECT f.run_id, f.feature_uri, f.feature_name,
           unnest(f.elements) AS e,
           unnest(range(1, len(f.elements) + 1)) AS elem_idx
    FROM ${featuresRelation} f
  )
),
bg AS (
  SELECT b.run_id, b.feature_uri, s.elem_id AS scenario_id,
         list_transform(b.steps, x -> struct_pack(
           keyword := x.keyword, name := x.name, line := x.line,
           match := x.match, result := x.result, is_background := true)) AS bg_steps
  FROM elems b
  JOIN elems s
    ON s.run_id = b.run_id AND s.feature_uri = b.feature_uri AND s.elem_idx = b.elem_idx + 1
  WHERE b.elem_type = 'background' AND s.elem_type = 'scenario'
),
scen AS (
  SELECT run_id, feature_uri, feature_name,
         elem_id AS scenario_id, elem_name AS scenario_name, tags,
         try_cast(start_timestamp AS TIMESTAMP) AS started_at,
         before_hooks, after_hooks,
         row_number() OVER (PARTITION BY run_id, feature_uri ORDER BY elem_idx) AS ordinal,
         list_transform(steps, x -> struct_pack(
           keyword := x.keyword, name := x.name, line := x.line,
           match := x.match, result := x.result, is_background := false)) AS own_steps
  FROM elems
  WHERE elem_type = 'scenario'
),
combined AS (
  SELECT sc.run_id, sc.feature_uri, sc.feature_name, sc.scenario_id, sc.scenario_name,
         sc.ordinal, sc.started_at, sc.tags, sc.before_hooks, sc.after_hooks,
         CASE WHEN bg.scenario_id IS NULL THEN sc.own_steps
              ELSE list_concat(bg.bg_steps, sc.own_steps) END AS steps
  FROM scen sc
  LEFT JOIN bg USING (run_id, feature_uri, scenario_id)
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
FROM combined`;
}

/** The v_steps SELECT (flatten scenario steps), parameterized by the scenarios
 *  source relation (a view name, or an inline scenarios subquery for one run). */
export function buildStepsSelectSql(scenariosRelation: string): string {
  return `
SELECT sc.run_id, sc.feature_uri, sc.scenario_id, sc.scenario_name,
  trim(s.keyword) || ' ' || s.name AS step_label, s.name AS step_name, trim(s.keyword) AS step_keyword,
  row_number() OVER (PARTITION BY sc.run_id, sc.scenario_id ORDER BY s.line) AS step_ordinal,
  s.is_background AS is_background,
  s.result.status AS status,
  s.result.duration / 1e9 AS duration_s,
  (s.result.error_message IS NOT NULL) AS has_error,
  left(s.result.error_message, 2000) AS error_message,
  s.match.location AS glue_location
FROM ${scenariosRelation} sc, UNNEST(sc.steps) AS t(s)`;
}

/** Global v_scenarios + v_steps views over v_features (all runs). Run detail and
 *  cross-run step history both read v_steps with a `WHERE run_id`/feature filter
 *  and trust DuckDB to skip non-matching per-run files via Parquet stats. */
export function buildScenariosStepsViewsSql(): string {
  return `
CREATE OR REPLACE VIEW v_scenarios AS ${buildScenariosSelectSql("v_features")};
CREATE OR REPLACE VIEW v_steps AS ${buildStepsSelectSql("v_scenarios")};`;
}

/**
 * Build the (run_id, scenario_id, test_id) SELECT, pulling the "Log of test
 * <id>" id out of each scenario's after-hook text/plain log embedding NAME.
 * Reads from v_features (the cached Parquet) - which already dropped the base64
 * `data` - so this is a single cheap pass over all runs, no batching needed
 * (unlike the old raw-JSON extraction, which had to batch to bound parse memory).
 *
 * nullif('') because regexp_extract returns '' (not NULL) when the embedding
 * name doesn't match, so a scenario whose log name didn't parse becomes NULL
 * (no Test ID shown) rather than an empty-valued row.
 *
 * Parameterized by the features relation (like buildScenariosSelectSql) so a
 * single out-of-window run can be read straight from its own Parquet - see
 * E2eStore.outOfWindowRun.
 */
export function buildTestIdsSelectSql(featuresRelation = "v_features"): string {
  return `
SELECT f.run_id,
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
FROM ${featuresRelation} f,
     UNNEST(f.elements) AS t(e)
WHERE e.type = 'scenario'`;
}

// ---------------------------------------------------------------------------
// Service versions (deployment tracking)
//
// Every scenario's log contains a block:
//
//     HH:MM:SS INFO Running services:
//     aqua = aqua:1.7.2
//     hartwig-api = hartwig-api:6.17.0-beta.1
//     diagnostic-pipeline-launcher = pipeline-launcher:5.5.11 --pipeline_version 5.33.13
//     ...
//     HH:MM:SS INFO <next log line>
//
// i.e. the image tag of every service deployed in the cluster the run executed
// against. buildServiceVersionsSelectSql extracts one (run_id, service, ...) row
// per service so the app can show "what was deployed for this run" and diff it
// against the previous run - linking failures to deployments.
//
// This is ANALYSIS over the cached Parquet's stored `log` (like
// buildTestIdsSelectSql over the embedding name), NOT a separate read of the raw
// report: the store materialises it into the `service_versions` table on each
// rebuild. So it needs no cache of its own, and editing the block regex/parse
// below needs no CACHE_VERSION bump - it just re-runs over the cached data. Only
// the version block is
// read; the rest of each log (which also carries synthetic patient/hospital ids)
// is ignored.
//
// Validated against all 71 local reports via the DuckDB CLI: every scenario emits
// the block, every run's scenarios agree (distinct_blocks = 1), and no non-service
// log line leaks in (the parse is anchored to the block).
// ---------------------------------------------------------------------------

/**
 * Build the (run_id, service, spec, image, version, pipeline_version,
 * n_scenarios, distinct_blocks) SELECT over the features relation's stored logs -
 * one row per (run, service). The store wraps it in `CREATE OR REPLACE TABLE
 * service_versions AS ...`; passing an inline `read_parquet([...])` instead reads
 * one out-of-window run directly (see E2eStore.outOfWindowRun).
 *
 * Pipeline: take each scenario's stored `log` -> regexp the "Running services:"
 * block (anchored between the header and the next timestamped line) -> per run,
 * pick the representative block with mode() (all scenarios agree in practice;
 * distinct_blocks surfaces the rare disagreement so the UI can disclaim it) ->
 * split into lines -> parse "name = image:tag [--pipeline_version X]". The
 * columns are typed by the expressions, so an empty v_features still yields a
 * correctly typed empty table (no placeholder needed).
 */
export function buildServiceVersionsSelectSql(
  featuresRelation = "v_features",
): string {
  return `
WITH scen AS (
  SELECT f.run_id, e.log AS log
  FROM ${featuresRelation} f,
       UNNEST(f.elements) AS t(e)
  WHERE e."type" = 'scenario'
),
blk AS (
  SELECT run_id,
         nullif(regexp_extract(log, 'Running services:[ \\t]*\\n([\\s\\S]*?)\\n[0-9]{2}:[0-9]{2}:[0-9]{2}', 1), '') AS block
  FROM scen
),
agg AS (
  SELECT run_id,
         mode(block) AS rep_block,
         count(DISTINCT block) AS distinct_blocks,
         count(*) AS n_scenarios
  FROM blk
  WHERE block IS NOT NULL
  GROUP BY run_id
),
lines AS (
  SELECT run_id, distinct_blocks, n_scenarios, trim(line) AS line
  FROM agg, UNNEST(string_split(rep_block, chr(10))) AS t(line)
),
parsed AS (
  SELECT run_id, distinct_blocks, n_scenarios,
         regexp_extract(line, '^([A-Za-z0-9._-]+)[ \\t]*=[ \\t]*(.*)$', 1) AS service,
         trim(regexp_extract(line, '^([A-Za-z0-9._-]+)[ \\t]*=[ \\t]*(.*)$', 2)) AS spec
  FROM lines
  WHERE line <> ''
)
SELECT
  run_id,
  service,
  nullif(spec, '') AS spec,
  nullif(regexp_extract(regexp_extract(spec, '^(\\S+)', 1), '^(.*):([^:]+)$', 1), '') AS image,
  nullif(regexp_extract(regexp_extract(spec, '^(\\S+)', 1), '^(.*):([^:]+)$', 2), '') AS version,
  nullif(regexp_extract(spec, '--pipeline_version[ \\t]+(\\S+)', 1), '') AS pipeline_version,
  n_scenarios,
  distinct_blocks
FROM parsed
WHERE service <> ''`;
}
