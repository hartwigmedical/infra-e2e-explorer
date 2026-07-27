#!/usr/bin/env tsx
/**
 * Phase 0 spike (throwaway) — de-risk the two unknowns for the SSR experiment:
 *
 *   1. Native DuckDB (@duckdb/node-api) can run the app's REAL slim-extraction
 *      SQL: read_json over a raw cucumber.json, base64-decode the log, and
 *      COPY the slim structure out to a Parquet file on disk.
 *   2. read_parquet(GLOB) over that on-disk slim cache reproduces the current
 *      client-side query results (scenarios/steps/test_ids/service_versions).
 *
 * It imports the ACTUAL SQL builders from app/lib/e2e-views.ts (which has no
 * imports of its own), so this exercises the real pipeline, not a copy. Local
 * synthetic reports in public/data stand in for the GCS reports.
 *
 * Run: npx tsx scripts/spike-native-duckdb.ts
 */

import { DuckDBInstance } from "@duckdb/node-api";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCHEMA_VERSION,
  buildSlimSelectSql,
  buildFeaturesViewSql,
  buildScenariosStepsViewsSql,
  buildTestIdsSelectSql,
  buildServiceVersionsSelectSql,
} from "../app/lib/e2e-views.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(REPO_ROOT, "public", "data");
const SCRATCH =
  process.env.SPIKE_OUT ?? path.join(REPO_ROOT, "scratchpad-spike");

const RUN_SAMPLE = Number(process.env.SPIKE_N ?? 6);

interface RunManifestEntry {
  run_id: string;
  file: string;
  source: string;
  size_bytes: number;
}

/** BigInt-safe stringify for printing DuckDB rows (BIGINT -> BigInt). */
function j(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x));
}

async function main() {
  console.log(`SCHEMA_VERSION = ${SCHEMA_VERSION}`);
  console.log(`scratch dir    = ${SCRATCH}\n`);

  const { mkdir } = await import("node:fs/promises");
  await mkdir(SCRATCH, { recursive: true });

  const manifest: RunManifestEntry[] = JSON.parse(
    await readFile(path.join(DATA_DIR, "runs.json"), "utf8"),
  );
  const sample = manifest.slice(0, RUN_SAMPLE);
  console.log(`Sampling ${sample.length} of ${manifest.length} local runs.\n`);

  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();

  // ---- (1) Extract each run's slim Parquet from raw cucumber.json ----
  const slimFiles: string[] = [];
  let extractOk = 0;
  const t0 = performance.now();
  for (const entry of sample) {
    const rawPath = path.join(DATA_DIR, entry.file);
    const outPath = path.join(SCRATCH, `slim_${entry.run_id}.parquet`);
    try {
      const select = buildSlimSelectSql(rawPath, entry.run_id);
      await conn.run(`COPY (${select}) TO '${outPath}' (FORMAT parquet);`);
      slimFiles.push(outPath);
      extractOk++;
    } catch (err) {
      console.error(
        `  extract FAILED ${entry.run_id}: ${(err as Error).message}`,
      );
    }
  }
  const extractMs = Math.round(performance.now() - t0);
  console.log(
    `(1) slim extraction: ${extractOk}/${sample.length} runs -> Parquet in ${extractMs}ms ` +
      `(${Math.round(extractMs / Math.max(extractOk, 1))}ms/run)\n`,
  );
  if (slimFiles.length === 0) throw new Error("no slim files produced");

  // ---- (2) read_parquet(GLOB) reproduces the analytical views ----
  // Use a GLOB (not the explicit file list) to prove globbing works natively.
  const glob = path.join(SCRATCH, "slim_*.parquet");
  await conn.run(buildFeaturesViewSql([glob]));
  await conn.run(buildScenariosStepsViewsSql());
  await conn.run(`CREATE OR REPLACE TABLE test_ids AS ${buildTestIdsSelectSql()};`);
  await conn.run(
    `CREATE OR REPLACE TABLE scenarios AS
       SELECT sr.* EXCLUDE (steps), ti.test_id
       FROM v_scenarios sr
       LEFT JOIN test_ids ti USING (run_id, scenario_id);`,
  );
  await conn.run(
    `CREATE OR REPLACE TABLE service_versions AS ${buildServiceVersionsSelectSql()};`,
  );

  // ---- Verification queries (would be React Router loaders in the real app) ----
  const t1 = performance.now();

  const perRun = (
    await conn.runAndReadAll(
      `SELECT run_id,
              count(*) AS scenarios,
              count(*) FILTER (WHERE status = 'passed')  AS passed,
              count(*) FILTER (WHERE status = 'failed')  AS failed,
              count(*) FILTER (WHERE status = 'skipped') AS skipped,
              count(test_id) AS with_test_id
       FROM scenarios GROUP BY run_id ORDER BY run_id DESC;`,
    )
  ).getRowObjects();

  const svc = (
    await conn.runAndReadAll(
      `SELECT run_id, count(*) AS services, max(distinct_blocks) AS distinct_blocks
       FROM service_versions GROUP BY run_id ORDER BY run_id DESC;`,
    )
  ).getRowObjects();

  const svcSample = (
    await conn.runAndReadAll(
      `SELECT service, image, version, pipeline_version
       FROM service_versions
       WHERE run_id = (SELECT max(run_id) FROM service_versions)
       ORDER BY service LIMIT 6;`,
    )
  ).getRowObjects();

  const queryMs = Math.round(performance.now() - t1);

  console.log("(2) read_parquet(GLOB) -> per-run scenario status:");
  for (const r of perRun) console.log("   ", j(r));
  console.log("\n    service_versions per run:");
  for (const r of svc) console.log("   ", j(r));
  console.log(
    `\n    sample services for newest run (${(svcSample[0] as any) ? "" : "none"}):`,
  );
  for (const r of svcSample) console.log("   ", j(r));

  console.log(`\n    all analytical queries ran in ${queryMs}ms.`);

  // Sanity assertions so a silent regression fails the spike.
  const totalScenarios = perRun.reduce((n, r) => n + Number(r.scenarios), 0);
  if (totalScenarios === 0) throw new Error("0 scenarios materialized");
  const anyStatuses = perRun.some(
    (r) => Number(r.passed) + Number(r.failed) + Number(r.skipped) > 0,
  );
  if (!anyStatuses) throw new Error("no scenario statuses computed");

  conn.closeSync();
  console.log(
    `\nOK — native DuckDB ran the real pipeline: ${extractOk} runs extracted, ` +
      `${totalScenarios} scenarios queried over a Parquet glob.`,
  );
}

main().catch((e) => {
  console.error("\nSPIKE FAILED:", e);
  process.exit(1);
});
