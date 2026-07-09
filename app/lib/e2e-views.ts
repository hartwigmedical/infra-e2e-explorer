/**
 * SQL for the four non-stored DuckDB views that expose the nested Cucumber
 * JSON e2e reports (served from /data) as clean, flat, queryable tables:
 *
 *   v_runs       - one row per run, derived straight from runs.json (no report parsing)
 *   v_features   - one row per (run, feature)
 *   v_scenarios  - one row per (run, scenario) - background elements excluded
 *   v_steps      - one row per (run, scenario, step)
 *
 * These are views, not materialized tables: every query against them re-reads
 * the underlying JSON via DuckDB's `read_json`, so there is nothing to keep in
 * sync when new runs land in runs.json - re-running buildE2eViewsSql() (or
 * just querying again after CREATE VIEW) always reflects the current manifest.
 *
 * app/contexts/E2eDataContext.tsx creates these views once per session and
 * then materializes `runs`/`scenarios`/`steps` TABLEs on top of them, so the
 * app never re-reads the underlying JSON on every query (see that file's doc
 * comment for the two-stage materialization strategy).
 *
 * Validated against 60 real report files (public/data, ~277MB total) via the
 * DuckDB CLI before being wired into the browser.
 *
 * v_features uses an EXPLICIT `columns` schema for read_json instead of
 * auto-detection (deviation from the original draft - see buildE2eViewsSql
 * doc comment below for why).
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

/**
 * Build the full CREATE OR REPLACE VIEW script for all four views.
 *
 * @param runsJsonUrl - absolute URL to runs.json (the run manifest)
 * @param reportUrls - absolute URLs to each run's cucumber.json report. Order
 *   doesn't matter for correctness: run_id is recovered per-row from the
 *   source filename via `filename = true`, not from array position.
 */
export function buildE2eViewsSql(runsJsonUrl: string, reportUrls: string[]): string {
  const runsJsonLiteral = sqlStringLiteral(runsJsonUrl);
  const reportUrlArray = sqlArrayLiteral(reportUrls);

  return `
-- runs overview straight from the manifest (no report parsing)
CREATE OR REPLACE VIEW v_runs AS
SELECT
  run_id, file, source, updated, size_bytes,
  strptime(regexp_extract(run_id, '^(\\d{4}-\\d{2}-\\d{2})', 1), '%Y-%m-%d')      AS run_date,
  regexp_extract(run_id, '^\\d{4}-\\d{2}-\\d{2}-(\\d{4})', 1)                       AS run_time,
  CASE WHEN run_id LIKE '%-ok%' THEN 'ok'
       WHEN run_id LIKE '%failed%' THEN 'failed' ELSE 'unknown' END             AS status_token,
  try_cast(regexp_extract(run_id, 'failed-(\\d+)-of-\\d+', 1) AS INTEGER)          AS failed_count,
  try_cast(regexp_extract(run_id, '-of-(\\d+)', 1) AS INTEGER)                    AS total_count,
  (regexp_extract(run_id, '^\\d{4}-\\d{2}-\\d{2}-(\\d{4})', 1) IN ('0000','0100','0200')) AS is_nightly
FROM read_json(${runsJsonLiteral});

-- one row per (run, feature)
CREATE OR REPLACE VIEW v_features AS
SELECT regexp_extract(filename, 'runs/([^/]+)/', 1) AS run_id,
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
