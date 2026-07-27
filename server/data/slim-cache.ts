/**
 * On-disk slim-Parquet cache for the server-side data layer (SSR experiment,
 * Phase 1). The server-side analogue of app/lib/report-cache.ts (IndexedDB), but
 * SHARED across all users instead of per-browser.
 *
 * Each run's raw cucumber.json is parsed to a compact slim Parquet EXACTLY ONCE
 * (buildSlimSelectSql - see app/lib/e2e-views.ts), then reused forever: a run
 * folder is immutable, so a cached file whose recorded size_bytes/source still
 * match the manifest is trusted as-is. Files live under a SCHEMA_VERSION dir, so
 * an extraction-schema change (which bumps SCHEMA_VERSION) lands in a fresh dir
 * and old files are simply never read again.
 *
 *   <cacheRoot>/<SCHEMA_VERSION>/slim_<run_id>.parquet   (the slim data)
 *   <cacheRoot>/<SCHEMA_VERSION>/slim_<run_id>.json      (validation sidecar)
 *
 * Extraction goes through native DuckDB: COPY (buildSlimSelectSql(rawPath,id)) TO
 * '<file>'. read_json reads the raw report path from the ReportSource (a local
 * public/data file, or a temp file the GCS source downloaded); the multi-MB
 * base64 blobs are decoded transiently for the log and dropped before the write.
 */

import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_VERSION, buildSlimSelectSql } from "../../app/lib/e2e-views.ts";
import { withConnection } from "./engine.ts";
import type { ReportSource, RunInfo } from "./sources.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Sidecar recording what a cached slim file was extracted from, so a re-upload
 *  (changed size_bytes/source) forces a re-extract - matching the SPA cache. */
interface SlimSidecar {
  run_id: string;
  size_bytes: number | null;
  source: string;
  extractedAt: number;
}

export class SlimCache {
  private dir: string;

  constructor(
    private source: ReportSource,
    cacheRoot = process.env.E2E_CACHE_DIR ||
      path.join(REPO_ROOT, ".cache", "slim"),
  ) {
    this.dir = path.join(cacheRoot, SCHEMA_VERSION);
  }

  private parquetPath(runId: string): string {
    return path.join(this.dir, `slim_${runId}.parquet`);
  }
  private sidecarPath(runId: string): string {
    return path.join(this.dir, `slim_${runId}.json`);
  }

  /** True when a valid cached slim file exists for this exact run version. */
  private async isFresh(run: RunInfo): Promise<boolean> {
    const parquet = this.parquetPath(run.run_id);
    const sidecar = this.sidecarPath(run.run_id);
    if (!existsSync(parquet) || !existsSync(sidecar)) return false;
    try {
      const meta = JSON.parse(await readFile(sidecar, "utf8")) as SlimSidecar;
      return meta.size_bytes === run.size_bytes && meta.source === run.source;
    } catch {
      return false;
    }
  }

  /**
   * Path to the run's slim Parquet, extracting on a miss. Isolated per run - a
   * failed extraction throws for THAT run only (the store skips it), never
   * corrupts the cache: we COPY to a temp file and atomically rename on success.
   */
  async ensureSlim(run: RunInfo): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const parquet = this.parquetPath(run.run_id);
    if (await this.isFresh(run)) return parquet;

    const opened = await this.source.openReport(run);
    const tmp = `${parquet}.tmp`;
    try {
      const select = buildSlimSelectSql(opened.path, run.run_id);
      // Single-quote-safe: run ids and our own paths contain no single quotes.
      // Own connection so parallel extractions (ensureMany) don't contend.
      await withConnection((conn) =>
        conn.run(`COPY (${select}) TO '${tmp}' (FORMAT parquet);`),
      );
      await rename(tmp, parquet);
      const sidecar: SlimSidecar = {
        run_id: run.run_id,
        size_bytes: run.size_bytes,
        source: run.source,
        extractedAt: Date.now(),
      };
      await writeFile(this.sidecarPath(run.run_id), JSON.stringify(sidecar));
      return parquet;
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
      await opened.cleanup();
    }
  }

  /**
   * Ensure slim Parquet for every run, returning the paths that succeeded (a
   * per-run failure is logged and omitted, never fatal - mirrors the SPA's
   * per-run isolation). Bounded concurrency keeps peak parse memory in check.
   */
  async ensureMany(runs: RunInfo[], concurrency = 6): Promise<string[]> {
    const paths: string[] = [];
    let next = 0;
    const worker = async () => {
      while (next < runs.length) {
        const run = runs[next++];
        try {
          paths.push(await this.ensureSlim(run));
        } catch (err) {
          console.warn(
            `[slim-cache] extraction failed for ${run.run_id} (run omitted):`,
            (err as Error)?.message ?? err,
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, runs.length) }, worker),
    );
    return paths;
  }

  /** The SCHEMA_VERSION-scoped cache directory (for globbing in the store). */
  get directory(): string {
    return this.dir;
  }
}
