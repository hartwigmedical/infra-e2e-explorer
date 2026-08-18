#!/usr/bin/env tsx
/**
 * Phase 1 smoke/parity test for the server-side data layer (server/data/*).
 *
 * Loads a window over the LOCAL synced reports (offline), then:
 *   - asserts the store's tables are internally consistent (the same invariants
 *     the Phase 0 spike checked, now through the real store);
 *   - times a COLD refresh (extract every run) vs a WARM refresh (all slim
 *     Parquet already cached) to show the cache pays off - the whole point of
 *     moving parse cost server-side.
 *
 * Run: npx tsx scripts/phase1-smoke.ts
 */

import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { E2eStore } from "../server/data/store.ts";
import { LocalReportSource } from "../server/data/sources.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = path.join(REPO_ROOT, ".cache-phase1-smoke");

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main() {
  // Isolated cache dir so COLD really is cold; scoped env for the store.
  process.env.E2E_CACHE_DIR = CACHE_DIR;
  await rm(CACHE_DIR, { recursive: true, force: true });

  const store = new E2eStore(new LocalReportSource());

  // ---- COLD: nothing cached, every run is extracted from raw JSON ----
  const t0 = performance.now();
  // ensureComplete, not ensure: this measures/asserts over the FULL dataset, so
  // it has to wait for extraction (loaders deliberately don't - see store.ts).
  const cold = await store.ensureComplete(true);
  const coldMs = Math.round(performance.now() - t0);
  console.log(
    `COLD build: ${cold.runCount} runs in ${coldMs}ms (${Math.round(coldMs / Math.max(cold.runCount, 1))}ms/run)`,
  );

  // ---- Invariants over the materialized tables ----
  const perRun = await store.query<{
    run_id: string;
    scenarios: number;
    failed: number;
    id_failed: number | null;
  }>(`
    SELECT r.run_id,
           count(s.scenario_id) AS scenarios,
           count(s.scenario_id) FILTER (WHERE s.status = 'failed') AS failed,
           r.failed_count AS id_failed
    FROM runs r LEFT JOIN scenarios s USING (run_id)
    GROUP BY r.run_id, r.failed_count
    ORDER BY r.run_id DESC;
  `);

  assert(perRun.length === cold.runCount, "one row per run");
  const totalScenarios = perRun.reduce((n, r) => n + r.scenarios, 0);
  assert(totalScenarios > 0, "scenarios materialized");

  // For runs whose id encodes a failed count (failed-N-of-M), the computed
  // failed-scenario count must match N - the strongest parity signal we have.
  const idBearing = perRun.filter((r) => r.id_failed != null);
  const mismatches = idBearing.filter((r) => r.failed !== r.id_failed);
  console.log(
    `parity: ${idBearing.length} runs carry a failed-count in their id; ${mismatches.length} mismatch`,
  );
  for (const m of mismatches) {
    console.log(`   MISMATCH ${m.run_id}: computed ${m.failed} vs id ${m.id_failed}`);
  }
  assert(mismatches.length === 0, "computed failures match run-id failed counts");

  // steps queryable via the v_steps view; service_versions extracted from logs.
  const [{ n: stepCount }] = await store.query<{ n: number }>(
    `SELECT count(*) AS n FROM v_steps;`,
  );
  assert(stepCount > 0, "steps queryable via v_steps");

  const svc = await store.query<{ runs: number; bad_blocks: number; services: number }>(
    `SELECT count(DISTINCT run_id) AS runs,
            count(*) FILTER (WHERE distinct_blocks <> 1) AS bad_blocks,
            count(*) AS services
     FROM service_versions;`,
  );
  console.log(
    `service_versions: ${svc[0].services} rows across ${svc[0].runs} runs, ${svc[0].bad_blocks} with distinct_blocks<>1`,
  );
  assert(svc[0].services > 0, "service_versions extracted");
  assert(svc[0].bad_blocks === 0, "every run's scenarios agree on the services block");

  // ---- WARM: rebuild again with every run's Parquet already on disk ----
  const t1 = performance.now();
  const warm = await store.ensureComplete(true);
  const warmMs = Math.round(performance.now() - t1);
  console.log(
    `WARM build: ${warm.runCount} runs in ${warmMs}ms (cache hit; ${coldMs}ms -> ${warmMs}ms)`,
  );
  assert(warm.runCount === cold.runCount, "warm sees the same runs");

  await rm(CACHE_DIR, { recursive: true, force: true });
  console.log(
    `\nOK — server data layer materialized ${cold.runCount} runs / ${totalScenarios} scenarios / ${stepCount} steps, parity clean.`,
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("\nPHASE 1 SMOKE FAILED:", e);
  process.exit(1);
});
