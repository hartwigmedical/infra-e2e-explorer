#!/usr/bin/env tsx
/**
 * Measure the memory + disk footprint of holding the FULL dataset in the
 * server-side store (the numbers behind the steps-on-demand decision).
 *
 * Materializes every local run (no window), then reports DuckDB memory, process
 * RSS, table row counts, and the on-disk cache size — and extrapolates
 * per-run so we can project to a large bucket.
 *
 * Run: npx tsx scripts/measure-footprint.ts
 */

import { rm, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { E2eStore } from "../server/data/store.ts";
import { LocalReportSource } from "../server/data/sources.ts";
import { query as duckQuery } from "../server/data/engine.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(REPO_ROOT, ".cache-footprint");

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const walk = async (d: string) => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else total += (await stat(p)).size;
    }
  };
  await walk(dir);
  return total;
}

async function main() {
  process.env.E2E_CACHE_DIR = CACHE;
  process.env.E2E_WARM_WINDOWS = ""; // don't let the warmer race this
  await rm(CACHE, { recursive: true, force: true });

  const store = new E2eStore(new LocalReportSource());

  const rssBefore = process.memoryUsage().rss;
  const t0 = performance.now();
  const state = await store.ensure(true); // full dataset
  const coldMs = Math.round(performance.now() - t0);
  const rssAfter = process.memoryUsage().rss;

  const runs = state.runCount;
  const [{ scenarios }] = await duckQuery<{ scenarios: number }>(
    "SELECT count(*) AS scenarios FROM scenarios",
  );
  const [{ steps }] = await duckQuery<{ steps: number }>(
    "SELECT count(*) AS steps FROM steps",
  );
  const [{ svc }] = await duckQuery<{ svc: number }>(
    "SELECT count(*) AS svc FROM service_versions",
  );

  // DuckDB's own memory accounting for the in-memory database.
  let duckMem = "n/a";
  try {
    const rows = await duckQuery<{ memory_usage: string }>(
      "SELECT memory_usage FROM pragma_database_size()",
    );
    duckMem = rows[0]?.memory_usage ?? "n/a";
  } catch (e) {
    duckMem = `n/a (${(e as Error).message})`;
  }

  const slimBytes = await dirSize(CACHE);

  const line = "-".repeat(52);
  console.log(`\n${line}\nFULL-DATASET FOOTPRINT (${runs} local runs, no window)\n${line}`);
  console.log(`cold build (extract+materialize) : ${coldMs} ms  (${(coldMs / runs).toFixed(1)} ms/run)`);
  console.log(`rows: ${runs} runs · ${scenarios} scenarios · ${steps} steps · ${svc} service-versions`);
  console.log(`DuckDB reported memory_usage      : ${duckMem}`);
  console.log(`process RSS delta                 : ${mb(rssAfter - rssBefore)}  (RSS now ${mb(rssAfter)})`);
  console.log(`on-disk slim cache               : ${mb(slimBytes)}  (${(slimBytes / runs / 1024).toFixed(1)} KB/run)`);

  console.log(`\nper-run: ${(steps / runs).toFixed(0)} steps, ${(scenarios / runs).toFixed(1)} scenarios`);
  console.log(`\nprojected RSS delta (linear) for a larger bucket:`);
  const perRunRss = (rssAfter - rssBefore) / runs;
  for (const n of [250, 500, 1000, 2000, 5000]) {
    console.log(`  ${String(n).padStart(5)} runs → ~${mb(perRunRss * n)} RSS · ~${(steps / runs * n / 1e6).toFixed(1)}M step rows · ~${mb(slimBytes / runs * n)} slim cache`);
  }
  console.log(
    "\nNote: RSS/linear projection is rough (DuckDB overhead is not purely per-row);\n" +
      "treat as an order-of-magnitude guide, and re-measure against the real bucket.",
  );

  await rm(CACHE, { recursive: true, force: true });
  process.exit(0);
}

main().catch((e) => {
  console.error("measure failed:", e);
  process.exit(1);
});
