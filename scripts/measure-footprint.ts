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
  process.env.E2E_WARM = "0"; // don't let the warmer race this (see warm.ts)
  process.env.E2E_WINDOW_DAYS = "0"; // measure the full local snapshot
  await rm(CACHE, { recursive: true, force: true });

  const store = new E2eStore(new LocalReportSource());

  const rssBefore = process.memoryUsage().rss;
  const t0 = performance.now();
  const state = await store.ensureComplete(true); // full dataset, extraction included
  const coldMs = Math.round(performance.now() - t0);
  const rssAfter = process.memoryUsage().rss;

  const runs = state.runCount;
  const [{ scenarios }] = await duckQuery<{ scenarios: number }>(
    "SELECT count(*) AS scenarios FROM scenarios",
  );
  // v_steps, not `steps`: steps are deliberately left as a VIEW over the cached
  // Parquet and read on demand - that's the decision this script measures.
  const [{ steps }] = await duckQuery<{ steps: number }>(
    "SELECT count(*) AS steps FROM v_steps",
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

  // "12.9 MiB" -> bytes, so the projection can use the HELD model rather than a
  // cold-build RSS delta that's mostly transient parse memory.
  const duckMemBytes = (() => {
    const m = /^([\d.]+)\s*(KiB|MiB|GiB)$/.exec(duckMem.trim());
    if (!m) return 0;
    const unit = { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[m[2]]!;
    return Number(m[1]) * unit;
  })();

  const slimBytes = await dirSize(CACHE);

  const line = "-".repeat(52);
  console.log(`\n${line}\nFULL-DATASET FOOTPRINT (${runs} local runs, no window)\n${line}`);
  console.log(`cold build (extract+materialize) : ${coldMs} ms  (${(coldMs / runs).toFixed(1)} ms/run)`);
  console.log(`rows: ${runs} runs · ${scenarios} scenarios · ${steps} steps · ${svc} service-versions`);
  console.log(`HELD model (DuckDB memory_usage) : ${duckMem}${duckMemBytes ? `  (${(duckMemBytes / runs / 1024).toFixed(0)} KB/run)` : ""}`);
  console.log(`cold-build PEAK (process RSS Δ)  : ${mb(rssAfter - rssBefore)}  (RSS now ${mb(rssAfter)})`);
  console.log(`on-disk slim cache               : ${mb(slimBytes)}  (${(slimBytes / runs / 1024).toFixed(1)} KB/run)`);

  console.log(`\nper-run: ${(steps / runs).toFixed(0)} steps, ${(scenarios / runs).toFixed(1)} scenarios`);
  console.log(`\nprojected for a larger window (linear in runs HELD):`);
  for (const n of [250, 500, 1000, 2000, 5000]) {
    const held = duckMemBytes ? `~${mb((duckMemBytes / runs) * n)} held` : "n/a";
    console.log(`  ${String(n).padStart(5)} runs → ${held} · ~${((steps / runs) * n / 1e6).toFixed(1)}M step rows · ~${mb((slimBytes / runs) * n)} slim cache`);
  }
  console.log(
    "\nNote: project from the HELD model, not from RSS. The RSS delta above is the\n" +
      "COLD-BUILD PEAK: it includes parsing every raw report once (~5 MB of JSON per\n" +
      "run, transient, one report at a time) and the allocator's high-water mark, so\n" +
      "it does NOT scale with the number of runs held — a warm start skips all of it.\n" +
      "Both are order-of-magnitude guides; re-measure against the real bucket.",
  );

  await rm(CACHE, { recursive: true, force: true });
  process.exit(0);
}

main().catch((e) => {
  console.error("measure failed:", e);
  process.exit(1);
});
