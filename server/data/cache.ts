/**
 * On-disk per-run Parquet cache for the server-side data layer. Shared across
 * all users (in prod it lives on a gcsfuse-mounted GCS bucket).
 *
 * Each run's raw cucumber.json is parsed to a compact Parquet EXACTLY ONCE
 * (buildSlimSelectSql - see app/lib/e2e-views.ts), then reused forever: a run
 * folder is immutable, so a cached file whose recorded size_bytes/source still
 * match the manifest is trusted as-is. Files live under a CACHE_VERSION dir, so
 * bumping CACHE_VERSION (on any extraction change) lands everything in a fresh
 * dir and the old one is simply never read again:
 *
 *   <cacheRoot>/<CACHE_VERSION>/<run_id>.parquet   (the data)
 *   <cacheRoot>/<CACHE_VERSION>/<run_id>.json      (validation sidecar)
 *
 * One file per run means run-scoped queries (`WHERE run_id = X`) let DuckDB skip
 * non-matching files via Parquet stats. Extraction goes through native DuckDB:
 * COPY (buildSlimSelectSql(rawPath,id)) TO '<file>'. The raw report path comes
 * from the ReportSource (a local public/data file, or a temp file the GCS source
 * downloaded); the multi-MB base64 blobs are decoded transiently for the log and
 * dropped before the write.
 */

import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CACHE_VERSION, buildSlimSelectSql } from "../../app/lib/e2e-views.ts";
import { withConnection } from "./engine.ts";
import type { ReportSource, RunInfo } from "./sources.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Sidecar recording what a cached file was extracted from, so a re-upload
 *  (changed size_bytes/source) forces a re-extract. */
interface CacheSidecar {
  run_id: string;
  size_bytes: number | null;
  source: string;
  extractedAt: number;
}

export class ReportCache {
  private dir: string;

  constructor(
    private source: ReportSource,
    cacheRoot = process.env.E2E_CACHE_DIR || path.join(REPO_ROOT, ".cache"),
  ) {
    this.dir = path.join(cacheRoot, CACHE_VERSION);
  }

  /** Path to a run's cached Parquet (whether or not it exists yet). */
  fileFor(runId: string): string {
    return path.join(this.dir, `${runId}.parquet`);
  }
  private sidecarPath(runId: string): string {
    return path.join(this.dir, `${runId}.json`);
  }

  /** True when a valid cached file exists for this exact run version. */
  private async isFresh(run: RunInfo): Promise<boolean> {
    const parquet = this.fileFor(run.run_id);
    const sidecar = this.sidecarPath(run.run_id);
    if (!existsSync(parquet) || !existsSync(sidecar)) return false;
    try {
      const meta = JSON.parse(await readFile(sidecar, "utf8")) as CacheSidecar;
      return meta.size_bytes === run.size_bytes && meta.source === run.source;
    } catch {
      return false;
    }
  }

  /**
   * Path to the run's cached Parquet, extracting on a miss. Isolated per run - a
   * failed extraction throws for THAT run only (the store skips it), never
   * corrupts the cache: we COPY to a temp file and rename on success.
   */
  async ensure(run: RunInfo): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const parquet = this.fileFor(run.run_id);
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
      const sidecar: CacheSidecar = {
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
   * Ensure a cached Parquet for every run, returning the paths that succeeded (a
   * per-run failure is logged and omitted, never fatal). Bounded concurrency
   * keeps peak parse memory in check.
   */
  async ensureMany(runs: RunInfo[], concurrency = 6): Promise<string[]> {
    const paths: string[] = [];
    let next = 0;
    const worker = async () => {
      while (next < runs.length) {
        const run = runs[next++];
        try {
          paths.push(await this.ensure(run));
        } catch (err) {
          console.warn(
            `[cache] extraction failed for ${run.run_id} (run omitted):`,
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

  /** The CACHE_VERSION-scoped cache directory. */
  get directory(): string {
    return this.dir;
  }
}
