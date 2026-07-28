/**
 * Report sources for the server-side data layer.
 *
 * A ReportSource answers two questions the store needs:
 *   1. `listRuns(since)` - which runs exist from `since` onwards (newest-first),
 *      with the metadata a cached Parquet is validated against
 *      (size_bytes/source).
 *   2. `openReport(run)` - a LOCAL file path to the run's raw cucumber.json,
 *      since native DuckDB's read_json reads real files.
 *
 * Two implementations, unified so the store and cache never care which:
 *   - LocalReportSource: the synced public/data manifest + files (offline dev /
 *     tests; populated by `npm run sync-data`).
 *   - GcsReportSource: the live bucket. openReport downloads the object to a
 *     temp file; the server reads the bucket directly, so no signed URLs are
 *     involved anywhere.
 */

import { Storage } from "@google-cloud/storage";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Per-run facts the store + cache need. */
export interface RunInfo {
  run_id: string;
  /** The report object name within the run folder (cucumber-parallel.json | cucumber.json). */
  source: string;
  size_bytes: number | null;
  updated: string | null;
}

/** A raw report opened as a local file path, plus a cleanup to release it. */
export interface OpenedReport {
  path: string;
  cleanup: () => Promise<void>;
}

export interface ReportSource {
  kind: "local" | "gcs";
  /** Runs whose date (run_id[:10]) is >= `since`, newest-first. */
  listRuns(since: string): Promise<RunInfo[]>;
  /** A local file path to the run's raw cucumber.json (+ cleanup). */
  openReport(run: RunInfo): Promise<OpenedReport>;
}

const NOOP_CLEANUP = async () => {};

// ---------------------------------------------------------------------------
// LOCAL: public/data/runs.json + public/data/runs/<run_id>/<file>
// ---------------------------------------------------------------------------

interface LocalManifestEntry {
  run_id: string;
  file: string;
  source: string;
  updated: string;
  size_bytes: number;
}

export class LocalReportSource implements ReportSource {
  readonly kind = "local" as const;
  private dataDir: string;
  private manifest: Map<string, LocalManifestEntry> | null = null;

  constructor(dataDir = path.join(REPO_ROOT, "public", "data")) {
    this.dataDir = dataDir;
  }

  private async loadManifest(): Promise<Map<string, LocalManifestEntry>> {
    if (this.manifest) return this.manifest;
    const raw = await readFile(path.join(this.dataDir, "runs.json"), "utf8");
    const entries = JSON.parse(raw) as LocalManifestEntry[];
    this.manifest = new Map(entries.map((e) => [e.run_id, e]));
    return this.manifest;
  }

  async listRuns(since: string): Promise<RunInfo[]> {
    const manifest = await this.loadManifest();
    return [...manifest.values()]
      .filter((e) => e.run_id.slice(0, 10) >= since)
      .sort((a, b) => (a.run_id < b.run_id ? 1 : -1)) // newest-first
      .map((e) => ({
        run_id: e.run_id,
        source: e.source,
        size_bytes: e.size_bytes,
        updated: e.updated,
      }));
  }

  async openReport(run: RunInfo): Promise<OpenedReport> {
    const entry = (await this.loadManifest()).get(run.run_id);
    if (!entry) throw new Error(`unknown local run: ${run.run_id}`);
    const filePath = path.join(this.dataDir, entry.file);
    if (!existsSync(filePath)) {
      throw new Error(`local report missing on disk: ${filePath}`);
    }
    // Already a local file - hand back the path directly, nothing to clean up.
    return { path: filePath, cleanup: NOOP_CLEANUP };
  }
}

// ---------------------------------------------------------------------------
// GCS: gs://<bucket>/<run_id>/<source>  (listing mirrors server/index.ts)
// ---------------------------------------------------------------------------

const CANDIDATE_SOURCES = ["cucumber-parallel.json", "cucumber.json"];

export class GcsReportSource implements ReportSource {
  readonly kind = "gcs" as const;
  private storage: Storage;
  private bucketName: string;
  /** Per-run resolved metadata, cached with NO TTL: a run folder is immutable
   *  once written, so the object's source/size/updated never change. Without
   *  this every rebuild (the warmer forces one every few minutes) would re-HEAD
   *  every run in the bucket - hundreds of requests per cycle. A miss is only
   *  paid once per run, per process. */
  private metaCache = new Map<string, RunInfo>();

  constructor(bucketName = process.env.E2E_BUCKET || "infra-e2e-test-reports") {
    // Application Default Credentials (workload identity in prod) - never a key.
    this.storage = new Storage();
    this.bucketName = bucketName;
  }

  private get bucket() {
    return this.storage.bucket(this.bucketName);
  }

  /** Run-folder prefixes >= `since`, newest-first. `startOffset` bounds the
   *  listing lexicographically (== chronologically, given the run-id format). */
  private async listRunIdPrefixes(startOffset: string): Promise<string[]> {
    const prefixes: string[] = [];
    let pageToken: string | undefined;
    do {
      const [, nextQuery, apiResponse] = await this.bucket.getFiles({
        delimiter: "/",
        autoPaginate: false,
        maxResults: 1000,
        pageToken,
        startOffset,
      });
      const response = apiResponse as { prefixes?: string[] } | undefined;
      if (Array.isArray(response?.prefixes)) prefixes.push(...response.prefixes);
      pageToken = (nextQuery as { pageToken?: string } | undefined)?.pageToken;
    } while (pageToken);

    return prefixes
      .map((p) => p.replace(/\/+$/, ""))
      .filter(Boolean)
      .sort()
      .reverse();
  }

  /** Resolve which candidate report object exists + its size/updated, memoized
   *  per run (see metaCache). Reports are named differently across report
   *  "eras", so we try the current name first. */
  private async resolveMeta(runId: string): Promise<RunInfo | null> {
    const cached = this.metaCache.get(runId);
    if (cached) return cached;

    for (const source of CANDIDATE_SOURCES) {
      try {
        const [md] = await this.bucket.file(`${runId}/${source}`).getMetadata();
        const info: RunInfo = {
          run_id: runId,
          source,
          size_bytes: md.size != null ? Number(md.size) : null,
          updated: md.updated ?? md.timeCreated ?? null,
        };
        this.metaCache.set(runId, info);
        return info;
      } catch (err) {
        if ((err as { code?: number })?.code !== 404) throw err;
      }
      // else: this candidate doesn't exist in this run folder — try the next.
    }
    // Not cached: a folder with no report yet may get one later (an in-flight
    // run), so we re-check it on the next listing rather than remembering null.
    return null;
  }

  async listRuns(since: string): Promise<RunInfo[]> {
    const runIds = (await this.listRunIdPrefixes(since)).filter(
      (id) => id.slice(0, 10) >= since,
    );
    const metas = await Promise.all(runIds.map((id) => this.resolveMeta(id)));
    return metas.filter((m): m is RunInfo => m !== null);
  }

  async openReport(run: RunInfo): Promise<OpenedReport> {
    const [buf] = await this.bucket.file(`${run.run_id}/${run.source}`).download();
    const dir = await mkdtemp(path.join(os.tmpdir(), "e2e-report-"));
    const filePath = path.join(dir, `${run.run_id}.json`);
    await writeFile(filePath, buf);
    return {
      path: filePath,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  }
}

/**
 * Pick the source from the environment.
 *
 * `E2E_SOURCE=gcs|local` is explicit and always wins. Otherwise the default
 * depends on the environment, so neither deployment can be silently wrong:
 *   - production -> GCS. The image does NOT contain public/data (it's
 *     .dockerignore'd), so defaulting to local there would fail at the first
 *     request with a confusing ENOENT.
 *   - dev/test -> local, so they run offline against `npm run sync-data` output.
 */
export function createReportSource(): ReportSource {
  const explicit = process.env.E2E_SOURCE;
  if (explicit === "gcs") return new GcsReportSource();
  if (explicit === "local") return new LocalReportSource();
  return process.env.NODE_ENV === "production"
    ? new GcsReportSource()
    : new LocalReportSource();
}
