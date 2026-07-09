import express from "express";
import cors from "cors";
import path from "node:path";
import { existsSync } from "node:fs";
import { Storage } from "@google-cloud/storage";

// ---------- config ----------

const PORT = Number(process.env.PORT) || 3001;
const BUCKET_NAME = process.env.E2E_BUCKET || "infra-e2e-test-reports";
const SIGNED_URL_TTL_SECONDS =
  Number(process.env.SIGNED_URL_TTL_SECONDS) || 900;

// Reports are named differently across report "eras" — try current era first.
const CANDIDATE_SOURCES = ["cucumber-parallel.json", "cucumber.json"];

const RUN_LIST_CACHE_TTL_MS = 60_000;
const PAGE_CONCURRENCY = 8;

// new Storage() picks up Application Default Credentials — impersonation
// locally, workload identity in prod. Do NOT hardcode a service account or key.
const storage = new Storage();
const bucket = storage.bucket(BUCKET_NAME);

// ---------- run-folder listing cache (~60s TTL) ----------
// Mirrors middle-layer's small in-memory cache TTL idea (see server/datasources.ts).

let runIdCache: { runIds: string[]; fetchedAt: number } | null = null;

async function listRunIds(): Promise<string[]> {
  const now = Date.now();
  if (runIdCache && now - runIdCache.fetchedAt < RUN_LIST_CACHE_TTL_MS) {
    return runIdCache.runIds;
  }

  const prefixes: string[] = [];
  let pageToken: string | undefined;
  do {
    const [, nextQuery, apiResponse] = await bucket.getFiles({
      delimiter: "/",
      autoPaginate: false,
      maxResults: 1000,
      pageToken,
    });
    const response = apiResponse as { prefixes?: string[] } | undefined;
    if (Array.isArray(response?.prefixes)) {
      prefixes.push(...response.prefixes);
    }
    pageToken = (nextQuery as { pageToken?: string } | undefined)?.pageToken;
  } while (pageToken);

  // Prefixes look like "2026-07-09-0200-failed-2-of-42/"; run_id sorts lexicographically
  // = chronologically, so descending string sort gives newest-first.
  const runIds = prefixes
    .map((p) => p.replace(/\/+$/, ""))
    .filter(Boolean)
    .sort()
    .reverse();

  runIdCache = { runIds, fetchedAt: now };
  return runIds;
}

// ---------- per-run metadata resolution cache (no TTL — objects are immutable) ----------

interface RunMeta {
  source: string;
  size: number | null;
  updated: string | null;
}

const runMetaCache = new Map<string, RunMeta>();

async function resolveRunMeta(runId: string): Promise<RunMeta | null> {
  const cached = runMetaCache.get(runId);
  if (cached) return cached;

  for (const source of CANDIDATE_SOURCES) {
    try {
      const [metadata] = await bucket.file(`${runId}/${source}`).getMetadata();
      const meta: RunMeta = {
        source,
        size: metadata.size != null ? Number(metadata.size) : null,
        updated: metadata.updated ?? metadata.timeCreated ?? null,
      };
      runMetaCache.set(runId, meta);
      return meta;
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code !== 404) {
        console.error(
          `Failed to get metadata for ${runId}/${source}:`,
          (err as Error)?.message ?? err,
        );
      }
      // else: this candidate doesn't exist in this run folder — try the next one.
    }
  }
  return null;
}

// ---------- signed URL generation (graceful degradation) ----------

let signErrorLogged = false;

async function trySignUrl(
  runId: string,
  source: string,
): Promise<{ url: string | null; reason?: string }> {
  try {
    const [url] = await bucket.file(`${runId}/${source}`).getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + SIGNED_URL_TTL_SECONDS * 1000,
    });
    return { url };
  } catch (err) {
    const reason = (err as Error)?.message ?? String(err);
    if (!signErrorLogged) {
      console.error(
        "Signed URL generation failed (degrading gracefully):",
        reason,
      );
      signErrorLogged = true;
    }
    return { url: null, reason };
  }
}

// ---------- concurrency helper ----------

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    const i = nextIndex++;
    if (i >= items.length) return;
    results[i] = await worker(items[i], i);
    return runNext();
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runNext()),
  );
  return results;
}

// ---------- query parsing ----------

function intParam(value: unknown, fallback: number): number {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

// ---------- app ----------

const app = express();

app.use(cors());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Safety cap on how many runs `?since=` can return in one response - a month
// window is bounded in practice, but this keeps a pathological (very old)
// `since` from returning the entire multi-year run history in one shot.
const SINCE_MAX_RUNS = 2000;

function sinceParam(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
}

app.get("/api/runs", async (req, res) => {
  const since = sinceParam(req.query.since);

  let allRunIds: string[];
  try {
    allRunIds = await listRunIds();
  } catch (err) {
    console.error(
      "Failed to list run folders from GCS:",
      (err as Error)?.message ?? err,
    );
    res.status(502).json({ error: "failed to list run folders from GCS" });
    return;
  }

  const total = allRunIds.length;

  // allRunIds is newest-first (see listRunIds); run_id.slice(0, 10) is the
  // run's date and string-compares correctly against `since`.
  let pageRunIds: string[];
  let limit: number | undefined;
  let offset: number | undefined;
  if (since) {
    pageRunIds = allRunIds
      .filter((runId) => runId.slice(0, 10) >= since)
      .slice(0, SINCE_MAX_RUNS);
  } else {
    limit = clamp(intParam(req.query.limit, 60), 1, 500);
    offset = Math.max(0, intParam(req.query.offset, 0));
    pageRunIds = allRunIds.slice(offset, offset + limit);
  }

  let signWarning: string | undefined;

  const runs = await mapWithConcurrency(
    pageRunIds,
    PAGE_CONCURRENCY,
    async (runId) => {
      const meta = await resolveRunMeta(runId);
      if (!meta) return null;

      const { url, reason } = await trySignUrl(runId, meta.source);
      if (reason && !signWarning) signWarning = reason;

      return {
        run_id: runId,
        source: meta.source,
        size_bytes: meta.size,
        updated: meta.updated,
        cucumberUrl: url,
      };
    },
  );

  res.json({
    total,
    ...(limit !== undefined ? { limit } : {}),
    ...(offset !== undefined ? { offset } : {}),
    ...(since ? { since } : {}),
    runs: runs.filter((r) => r !== null),
    ...(signWarning ? { warning: `signing unavailable: ${signWarning}` } : {}),
  });
});

// Serve the built client in production (single deployable). In dev, Vite serves
// the client and proxies /api to this server instead, so this is a no-op then.
const clientDir = path.resolve(import.meta.dirname, "../build/client");
if (existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get("*path", (_req, res) => {
    res.sendFile(path.join(clientDir, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`e2e-explorer server listening on http://localhost:${PORT}`);
  console.log(`Bucket: gs://${BUCKET_NAME}`);
});
