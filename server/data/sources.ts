/**
 * Report sources for the server-side data layer (SSR experiment, Phase 1).
 *
 * A ReportSource answers two questions the store needs:
 *   1. `listRuns(since)` - which runs fall in the window (newest-first), with the
 *      metadata a cached slim Parquet is validated against (size_bytes/source).
 *   2. `openReport(run)` - a LOCAL file path to the run's raw cucumber.json, since
 *      native DuckDB's read_json reads real files (no virtual FS like WASM had).
 *
 * Two implementations, unified so the store and slim-cache never care which:
 *   - LocalReportSource: the synced public/data manifest + files (offline dev /
 *     tests; the same data the SPA's LOCAL mode uses).
 *   - GcsReportSource: the live bucket - listing mirrors server/index.ts, and
 *     openReport downloads the object to a temp file (no signed URLs; the server
 *     reads the bucket directly).
 */

import { Storage } from "@google-cloud/storage";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Per-run facts the store + slim-cache need. Mirrors the SPA's RunInfo/ApiRun. */
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

  constructor(bucketName = process.env.E2E_BUCKET || "infra-e2e-test-reports") {
    // Application Default Credentials (workload identity in prod) - never a key.
    this.storage = new Storage();
    this.bucketName = bucketName;
  }

  private get bucket() {
    return this.storage.bucket(this.bucketName);
  }

  /** Run-folder prefixes >= `since`, newest-first (see server/index.ts). */
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

  /** Resolve which candidate report object exists + its size/updated. */
  private async resolveMeta(runId: string): Promise<RunInfo | null> {
    for (const source of CANDIDATE_SOURCES) {
      try {
        const [md] = await this.bucket.file(`${runId}/${source}`).getMetadata();
        return {
          run_id: runId,
          source,
          size_bytes: md.size != null ? Number(md.size) : null,
          updated: md.updated ?? md.timeCreated ?? null,
        };
      } catch (err) {
        if ((err as { code?: number })?.code !== 404) throw err;
      }
    }
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
 * Pick the source from the environment: GCS when a bucket is configured for live
 * use (E2E_SOURCE=gcs), else the local synced manifest. Phase 1 tests default to
 * local so they run offline.
 */
export function createReportSource(): ReportSource {
  return process.env.E2E_SOURCE === "gcs"
    ? new GcsReportSource()
    : new LocalReportSource();
}
