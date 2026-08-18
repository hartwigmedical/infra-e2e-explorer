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
import { mapWithConcurrency } from "./concurrency.ts";
import type { ReportSource, RunInfo } from "./sources.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Concurrent sidecar reads when checking what's already cached (partition).
 *  Higher than the extraction limit - these are tiny reads, not parses. */
const FRESHNESS_CONCURRENCY = 32;

/** Disambiguates concurrent extractions within this process (see ensure). */
let nextTmpSeq = 0;

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
  /** Memoized writability probe (see ensureWritable). */
  private writable: Promise<void> | null = null;

  constructor(
    private source: ReportSource,
    cacheRoot = process.env.E2E_CACHE_DIR || path.join(REPO_ROOT, ".cache"),
  ) {
    this.dir = path.join(cacheRoot, CACHE_VERSION);
  }

  /**
   * Create the cache dir and prove we can write in it, once per process.
   *
   * Checked up front and FATAL by design: without a writable cache every
   * extraction fails, and since per-run failures are (correctly) non-fatal the
   * app would otherwise boot "successfully" and serve a run list with zero
   * scenarios everywhere. `mkdir -p` alone isn't enough of a check - it succeeds
   * on an existing dir we have no write permission on (e.g. a root-owned
   * /app/.cache in the container while the process runs as `node`).
   */
  ensureWritable(): Promise<void> {
    if (!this.writable) {
      this.writable = (async () => {
        const probe = path.join(this.dir, ".writable");
        try {
          await mkdir(this.dir, { recursive: true });
          await writeFile(probe, "");
          await rm(probe, { force: true });
        } catch (err) {
          // Not memoized on failure: a mount that appears late should recover.
          this.writable = null;
          throw new Error(
            `cache dir is not writable: ${this.dir} - set E2E_CACHE_DIR to a writable path (${(err as Error)?.message ?? err})`,
          );
        }
      })();
    }
    return this.writable;
  }

  /** Path to a run's cached Parquet (whether or not it exists yet). */
  fileFor(runId: string): string {
    return path.join(this.dir, `${runId}.parquet`);
  }

  /** Path to a run's cached Parquet, or null when it isn't extracted yet - for
   *  callers that want to read ONE run instead of the whole-window view. */
  cachedFileFor(runId: string): string | null {
    const parquet = this.fileFor(runId);
    return existsSync(parquet) ? parquet : null;
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
    await this.ensureWritable();
    const parquet = this.fileFor(run.run_id);
    if (await this.isFresh(run)) return parquet;

    const opened = await this.source.openReport(run);
    // Unique per process AND per call: the cache is shared (a gcsfuse mount
    // across instances), where a fixed `.tmp` name lets two extractions of the
    // same run write the same bytes-in-progress, and `rename` is copy+delete
    // rather than atomic. The sidecar is still written only AFTER the rename, so
    // a half-copied file is never considered fresh - it just gets re-extracted.
    const tmp = `${parquet}.${process.pid}-${nextTmpSeq++}.tmp`;
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
   * Split runs into the ones already cached (their Parquet paths) and the ones
   * needing extraction. Reads only the sidecars, so it's cheap enough for the
   * request path - what lets the store materialize over what's cached NOW and
   * leave extraction to the background (see store.ts).
   */
  async partition(
    runs: RunInfo[],
  ): Promise<{ cached: string[]; missing: RunInfo[] }> {
    const fresh = await mapWithConcurrency(runs, FRESHNESS_CONCURRENCY, (run) =>
      this.isFresh(run),
    );
    const cached: string[] = [];
    const missing: RunInfo[] = [];
    runs.forEach((run, i) => {
      if (fresh[i]) cached.push(this.fileFor(run.run_id));
      else missing.push(run);
    });
    return { cached, missing };
  }

  /**
   * Ensure a cached Parquet for every run, returning the paths that succeeded (a
   * per-run failure is logged and omitted, never fatal). Bounded concurrency
   * keeps peak parse memory in check.
   */
  async ensureMany(runs: RunInfo[], concurrency = 6): Promise<string[]> {
    const paths = await mapWithConcurrency(runs, concurrency, async (run) => {
      try {
        return await this.ensure(run);
      } catch (err) {
        console.warn(
          `[cache] extraction failed for ${run.run_id} (run omitted):`,
          (err as Error)?.message ?? err,
        );
        return null;
      }
    });
    return paths.filter((p): p is string => p !== null);
  }

  /** The CACHE_VERSION-scoped cache directory. */
  get directory(): string {
    return this.dir;
  }
}
