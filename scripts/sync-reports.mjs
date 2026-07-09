#!/usr/bin/env node
/**
 * Sync recent Cucumber e2e reports from the GCS bucket gs://infra-e2e-test-reports
 * into public/data/, and build an index at public/data/runs.json.
 *
 * Data is confirmed SYNTHETIC test-infra data (no real patient/clinical content).
 *
 * Usage:
 *   node scripts/sync-reports.mjs [count] [--bucket gs://other-bucket] [--force]
 *   N=100 node scripts/sync-reports.mjs
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(REPO_ROOT, "public", "data");
const RUNS_DIR = path.join(DATA_DIR, "runs");
const RUNS_INDEX_PATH = path.join(DATA_DIR, "runs.json");

const CONCURRENCY = 6;
const DEFAULT_BUCKET = "gs://infra-e2e-test-reports";
const DEFAULT_COUNT = 60;

// ---------- CLI args ----------

function parseArgs(argv) {
  let count = null;
  let bucket = null;
  let force = false;
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--bucket") {
      bucket = argv[++i];
    } else if (arg.startsWith("--bucket=")) {
      bucket = arg.slice("--bucket=".length);
    } else if (arg === "--force") {
      force = true;
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }

  if (positional.length > 0 && !Number.isNaN(Number(positional[0]))) {
    count = Number(positional[0]);
  }

  return {
    count: count ?? (process.env.N ? Number(process.env.N) : DEFAULT_COUNT),
    bucket: (bucket ?? process.env.BUCKET ?? DEFAULT_BUCKET).replace(/\/+$/, ""),
    force,
  };
}

// ---------- gcloud helpers ----------

async function gcloudStorage(args) {
  const { stdout } = await execFileAsync("gcloud", ["storage", ...args], {
    maxBuffer: 1024 * 1024 * 64,
  });
  return stdout;
}

/** List immediate children of a gs:// prefix (folders end with '/'). */
async function listChildren(gsUri) {
  const stdout = await gcloudStorage(["ls", gsUri.endsWith("/") ? gsUri : `${gsUri}/`]);
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Get {size, updated} for a gs:// object, or nulls on failure. */
async function describeObject(gsUri) {
  try {
    const stdout = await gcloudStorage([
      "objects",
      "describe",
      gsUri,
      "--format=json(size,update_time)",
    ]);
    const parsed = JSON.parse(stdout);
    const size = typeof parsed.size === "number" ? parsed.size : Number(parsed.size) || null;
    const updated = parsed.update_time
      ? new Date(parsed.update_time).toISOString()
      : null;
    return { size, updated };
  } catch (err) {
    return { size: null, updated: null, error: err };
  }
}

async function downloadObject(gsUri, destPath) {
  await mkdir(path.dirname(destPath), { recursive: true });
  await gcloudStorage(["cp", gsUri, destPath]);
}

// ---------- concurrency pool ----------

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    const i = nextIndex++;
    if (i >= items.length) return;
    results[i] = await worker(items[i], i);
    return runNext();
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => runNext());
  await Promise.all(runners);
  return results;
}

// ---------- local fs helpers ----------

async function localFileNonEmpty(filePath) {
  try {
    const s = await stat(filePath);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

async function loadPreviousIndex() {
  try {
    const raw = await readFile(RUNS_INDEX_PATH, "utf8");
    const arr = JSON.parse(raw);
    const map = new Map();
    for (const entry of arr) {
      if (entry && entry.run_id) map.set(entry.run_id, entry);
    }
    return map;
  } catch {
    return new Map();
  }
}

// ---------- main ----------

async function main() {
  const { count, bucket, force } = parseArgs(process.argv.slice(2));

  if (!Number.isFinite(count) || count <= 0) {
    console.error(`Invalid count: ${count}`);
    process.exit(1);
  }

  console.log(`Bucket: ${bucket}`);
  console.log(`Requested window: ${count} most recent runs${force ? " (--force: re-downloading everything)" : ""}`);

  // 1. List all run folders.
  let rawChildren;
  try {
    rawChildren = await listChildren(bucket);
  } catch (err) {
    console.error(`ERROR: failed to list bucket "${bucket}".`);
    console.error(`  This likely means gcloud is not authenticated, or the bucket is unreadable.`);
    console.error(`  Underlying error:`);
    console.error(String(err.stderr || err.message || err));
    process.exit(1);
  }

  const bucketPrefix = `${bucket}/`;
  const runIds = rawChildren
    .filter((line) => line.startsWith(bucketPrefix) && line.endsWith("/"))
    .map((line) => line.slice(bucketPrefix.length, -1))
    .filter(Boolean);

  if (runIds.length === 0) {
    console.error(`ERROR: no run folders found under ${bucket}. Nothing to sync.`);
    process.exit(1);
  }

  runIds.sort().reverse(); // run IDs are date-prefixed strings -> lexicographic sort = chronological
  const selected = runIds.slice(0, count);

  console.log(`Found ${runIds.length} total run folders; syncing ${selected.length}.`);

  await mkdir(RUNS_DIR, { recursive: true });
  const previousIndex = await loadPreviousIndex();

  const stats = {
    downloaded: 0,
    skippedCached: 0,
    usedParallel: 0,
    usedLegacy: 0,
    failed: [],
  };

  const entries = await runWithConcurrency(selected, CONCURRENCY, async (runId) => {
    const localPath = path.join(RUNS_DIR, runId, "cucumber.json");
    const localOk = await localFileNonEmpty(localPath);
    const cached = previousIndex.get(runId);

    // Fast path: already synced locally and we have a trustworthy index entry for it.
    if (localOk && !force && cached && cached.file === `runs/${runId}/cucumber.json`) {
      stats.skippedCached++;
      if (cached.source === "cucumber-parallel.json") stats.usedParallel++;
      else if (cached.source === "cucumber.json") stats.usedLegacy++;
      return {
        run_id: runId,
        file: `runs/${runId}/cucumber.json`,
        source: cached.source ?? null,
        updated: cached.updated ?? null,
        size_bytes: cached.size_bytes ?? null,
      };
    }

    // Otherwise: determine which report file exists in the folder.
    let children;
    try {
      children = await listChildren(`${bucket}/${runId}`);
    } catch (err) {
      stats.failed.push({ run_id: runId, reason: `list failed: ${err.message || err}` });
      return null;
    }

    const names = children.map((l) => l.split("/").filter(Boolean).pop());
    let source = null;
    if (names.includes("cucumber-parallel.json")) {
      source = "cucumber-parallel.json";
    } else if (names.includes("cucumber.json")) {
      source = "cucumber.json";
    }

    if (!source) {
      stats.failed.push({ run_id: runId, reason: "no cucumber-parallel.json or cucumber.json found" });
      return null;
    }

    const gsUri = `${bucket}/${runId}/${source}`;
    const { size, updated } = await describeObject(gsUri);

    if (!localOk || force) {
      try {
        await downloadObject(gsUri, localPath);
        stats.downloaded++;
      } catch (err) {
        stats.failed.push({ run_id: runId, reason: `download failed: ${err.message || err}` });
        return null;
      }
    } else {
      // Local file exists but we lacked a trustworthy cached index entry; skip re-download.
      stats.skippedCached++;
    }

    if (source === "cucumber-parallel.json") stats.usedParallel++;
    else stats.usedLegacy++;

    return {
      run_id: runId,
      file: `runs/${runId}/cucumber.json`,
      source,
      updated,
      size_bytes: size,
    };
  });

  const validEntries = entries.filter(Boolean);
  validEntries.sort((a, b) => (a.run_id < b.run_id ? 1 : a.run_id > b.run_id ? -1 : 0));

  await writeFile(RUNS_INDEX_PATH, JSON.stringify(validEntries, null, 2) + "\n", "utf8");

  // ---------- summary ----------
  const totalBytes = validEntries.reduce((sum, e) => sum + (e.size_bytes || 0), 0);
  const oldest = validEntries[validEntries.length - 1]?.run_id ?? "n/a";
  const newest = validEntries[0]?.run_id ?? "n/a";

  console.log("");
  console.log("=== Sync summary ===");
  console.log(`Runs in index:        ${validEntries.length} (requested ${count})`);
  console.log(`Downloaded this run:  ${stats.downloaded}`);
  console.log(`Skipped (cached):     ${stats.skippedCached}`);
  console.log(`Source era:           parallel=${stats.usedParallel}, legacy=${stats.usedLegacy}`);
  console.log(`Total bytes on disk:  ${totalBytes} (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`Date range:           ${oldest} .. ${newest}`);
  if (stats.failed.length > 0) {
    console.log(`Failed runs (${stats.failed.length}):`);
    for (const f of stats.failed) {
      console.log(`  - ${f.run_id}: ${f.reason}`);
    }
  } else {
    console.log(`Failed runs:          0`);
  }
  console.log(`Index written to:     ${path.relative(REPO_ROOT, RUNS_INDEX_PATH)}`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
