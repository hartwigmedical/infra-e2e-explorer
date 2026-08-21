# e2e-explorer

> ⚠️ **Disclaimer:** this project is ~99% vibe-coded — built almost entirely through
> AI prompting / pair-programming rather than hand-written line by line. Treat it
> accordingly and review before relying on it.

An explorer for the Cucumber end-to-end test results produced by the
[`verification`](../verification) suite. It answers questions the per-run Cluecumber
HTML reports can't:

1. **What do the most recent runs look like?** — a dashboard of runs with status, failed/total,
   per-run scenario pass/fail/skip counts, and a pass-rate trend.
2. **When did a given scenario / step start failing?** — a cross-run history strip per scenario
   and a step × run grid, so regressions are obvious at a glance.
3. **What was deployed, and did a deploy break it?** — per-run service versions plus a
   services × runs timeline that flags deploys which introduced lasting failures.

## How it works

**Server-rendered** (React Router SSR on Express). Pages arrive as HTML with the data already in
them — no client-side query engine, no loading waterfall, and a plain `curl`/LLM fetch sees the
real content. All data access happens in route **loaders** (`app/lib/data.server.ts` →
`server/data/*`); the browser only gets presentational components plus cheap in-memory
filtering/sorting.

### The data layer

Queries run against **native DuckDB** in-process (`@duckdb/node-api`). The deeply-nested Cucumber
JSON is exposed as clean SQL over `read_json` + `UNNEST` — all of it built in
`app/lib/e2e-views.ts`, the single source of truth for the schema and the analysis:

| Relation                        | Kind             | Notes                                                     |
| ------------------------------- | ---------------- | --------------------------------------------------------- |
| `runs`                          | table            | one row per run, derived from the run-folder name only     |
| `scenarios`                     | table            | one row per (run, scenario), with `test_id`                |
| `test_ids`, `service_versions`  | tables           | analysis over the cached reports                           |
| `v_features`, `v_scenarios`     | views            | over the per-run cached Parquet                            |
| `v_steps`                       | view             | **not materialized** — queried on demand (see below)       |

The store (`server/data/store.ts`) holds a **rolling window** of runs — `E2E_WINDOW_DAYS`, 90 by
default. `ensure()` (re)builds those tables over that window, serialized so concurrent requests
can't race, and reused within a short TTL so request bursts don't rebuild.

A rebuild is **one transaction on its own connection**: DuckDB's DDL is transactional, so readers see
either the whole previous model or the whole new one — never a re-warm's half-applied state (new run
rows with blank scenario counts, matrix columns with no cells) — and a rebuild doesn't occupy the
connection every loader query takes its turn on.

The window is what keeps this cheap. The bucket is append-only since 2023 (~1200 runs and counting),
and both the GCS listing and the per-rebuild analysis pass are proportional to the number of runs
held — so without a window they'd grow with the lifetime of the project rather than with what anyone
actually looks at. A dashboard of "what happened recently" doesn't need the tail.

Runs **older** than the window are still reachable by direct link: `outOfWindowRun()` resolves the
run in the bucket, extracts it if it isn't cached yet, and hands back a relation over just that run's
Parquet, which the run-detail route queries through the same (parameterized) view builders. Such a
run is deliberately *not* folded into the model — that would leak an ancient run into the run list,
the header's date range and the "previous run" subqueries behind the diffs, and cost a full rebuild
per deep link. The trade-off is that cross-run comparisons (pass/fail trend, deployment diff) aren't
available for it, because its neighbours aren't loaded either; the page says so.

`steps` is deliberately left as a view: it's ~90% of all rows, and it's only ever needed for **one
run** (run detail) or **one scenario** (step history) at a time. Keeping it out of memory holds the
resident model at ~0.2 MB/run (DuckDB's own accounting: 12.9 MiB for 60 runs, so ~26 MB for a 90-day
window) instead of ~1 MB/run. `scripts/measure-footprint.ts` reproduces those numbers — read its
*held* figure, not its cold-build RSS peak, which is dominated by one-off report parsing.

### The report cache

A raw report is ~90% base64 embedding blobs the app doesn't need. So each run's report is parsed
**exactly once** into a compact Parquet — the feature/scenario/step structure with those blobs
stripped, but keeping the decoded `text/plain` scenario **log** (a ~9 MB report → ~120 KB). Files
are cached on disk, one per run, keyed by the immutable `run_id`:

```
$E2E_CACHE_DIR/<CACHE_VERSION>/<run_id>.parquet   # the data
$E2E_CACHE_DIR/<CACHE_VERSION>/<run_id>.json      # what it was extracted from
```

Because run folders are immutable, a cached file whose recorded `size_bytes`/`source` still match
is trusted as-is — so a warm cache does **zero** report downloads or parsing, and only genuinely
new runs cost anything. All analysis (`v_scenarios` / `v_steps` / `test_ids` / `service_versions`)
**and** the run-detail Log button read this cache, so nothing ever re-reads the raw JSON.

A background **warmer** (`server/data/warm.ts`) materializes at startup and re-runs on an interval,
so new runs are extracted proactively rather than in a user's request.

Extraction is **never** in the request path: `ensure()` materializes over the runs whose Parquet is
already cached and hands the rest to the warmer's background pass, so a cold instance serves the run
list immediately and fills in scenario data as runs land (rather than blocking every request —
including `/` — on a full extraction and getting killed by Cloud Run's request timeout).
`ensureComplete()` is the waiting variant, used by the warmer and the measurement scripts.

While that's happening the UI says so: the shell loader reports `cachedRunCount` / `pendingRunCount`
and `app/components/BuildProgress.tsx` shows a "Building data model — N / M runs ready" banner,
revalidating every 5 s until nothing is pending. Runs that aren't extracted yet render with an em
dash instead of counts, so a half-built dashboard reads as *building* rather than as a dataset with
holes in it. Because the cache lives on a shared mount, a new instance usually starts warm and the
banner never appears.

> **Cache invalidation:** `CACHE_VERSION` in `app/lib/e2e-views.ts` is a hand-bumped constant.
> **Bump it whenever you change the extraction** (what/how we store in the Parquet). Files then land
> in a fresh `<CACHE_VERSION>/` directory and the old one is simply never read again — orphaned dirs
> can be reaped with a GCS lifecycle rule. You do **not** need to bump it for changes to the
> *analysis* SQL (status/background/test-id/service-version logic), which re-runs over the cache on
> every rebuild.

> Note: extraction uses an explicit `columns=` schema rather than `read_json` auto-detection —
> explicit typing sidesteps schema drift between report eras and bounds parse memory. The schema
> pulls the `text/plain` embedding's `data` so the log can be decoded at parse time, but
> `buildSlimSelectSql` stores only the decoded string and drops every base64 blob — so the huge
> screenshot/video zips are read transiently (one report at a time) yet never land in the cache.

### View scope vs. data scope

Two separate bounds. The **data** scope is the store's window (`E2E_WINDOW_DAYS`). Within it, the two
**wide** views (Scenarios matrix, Services timeline) render one column per run, so they bound how many
recent runs they *display* via `?runs=N` (default 60, hard cap 2000, with a "show all" link that keeps
the page's other filters) — a UI/payload bound, see `app/lib/view.ts`.

The **nightly / all-runs** toggle is a client-side view preference over already-loaded data
(`app/contexts/RunScopeContext.tsx`), not a query parameter.

### Service versions (deployment tracking)

Every scenario's log embeds a `Running services:` block (`service = image:tag` per deployment in the
cluster the run tested against). Since the log lives in the cached Parquet, we parse that block as
plain **analysis over the cache** — like `test_ids`, not a separate read of the raw report — into a
per-run `(service, image, version, …)` set (`buildServiceVersionsSelectSql`). It drives the
run-detail "what was deployed" panel (plus a diff against the previous run) and the `/services`
timeline. The scenarios in a run agree on their versions in practice (validated across all local
reports); the rare disagreement is surfaced with a disclaimer rather than modelled per-scenario.
Only the version block is read — the rest of each log (which carries synthetic patient/hospital
ids) is ignored.

## Quick start

Prerequisites: Node (npm ≥ 11.10 for the `min-release-age` policy) and `gcloud` authenticated with
read access to `gs://infra-e2e-test-reports`.

```bash
npm install
npm run sync-data     # copies the ~60 most recent runs into public/data/ + writes runs.json
npm run dev           # http://localhost:3001 (Express + Vite middleware, SSR)
```

Dev is a **single process**: Express serves the app and runs Vite in middleware mode. It reads the
local `public/data/` snapshot by default, so it works offline.

`sync-data` is idempotent (skips runs already downloaded; `--force` to re-fetch). Fetch more with
`N=120 npm run sync-data`.

To run dev against the live bucket instead: `E2E_SOURCE=gcs npm run dev`.

## Routes

| Route               | What it shows                                                             |
| ------------------- | ------------------------------------------------------------------------- |
| `/`                 | Recent Runs dashboard (status, failed/total, scenario counts, trend)      |
| `/runs/:runId`      | Run detail — features → scenarios → steps, failures surfaced, step errors |
| `/runs/:runId/logs` | Resource route (JSON) — per-scenario logs, fetched on demand              |
| `/scenarios`        | Scenario matrix (status / duration / stability) + per-scenario history     |
| `/services`         | Services × runs deployment timeline, with suspect deploys flagged          |
| `/api/health`       | `{ "ok": true }`                                                          |

## Data source

`gs://infra-e2e-test-reports` — one folder per run, named
`YYYY-MM-DD[-HHMM][-ok|-failed][-N-of-M]`. `-0200-` folders are the scheduled nightly full runs;
odd-time folders are manual re-runs (`is_nightly=false`, filtered out by default). Current-era
reports are `cucumber-parallel.json`; pre-2025 are `cucumber.json` (the sync script normalizes both
to `cucumber.json` locally). This is **synthetic** test-infrastructure data.

The server reads the bucket **directly** (`server/data/sources.ts`) — it downloads a report once,
extracts it, and caches the result. There are no signed URLs and no browser-to-GCS traffic, so the
bucket needs no CORS configuration and the runtime identity only needs plain read access
(`roles/storage.objectViewer`) — notably **not** IAM `signBlob`.

The reports' large base64 embedding blobs (screenshot/video zips) are **deliberately excluded** from
the data model — nothing loads or renders them. The one exception is each scenario's `text/plain`
log, which is decoded at extraction time and kept (see the report cache above).

> Read access to `gs://infra-e2e-test-reports` is currently granted via the legacy
> `roles/storage.legacyBucketReader`/`legacyObjectReader` bindings on
> `projectViewer:hmf-pipeline-development` — i.e. any principal with at least Viewer on that project
> can read the bucket. A dedicated bucket-scoped reader service account for the runtime identity
> would be better than relying on the broad project-Viewer grant.

## Scripts

- `npm run dev` — dev server (SSR + Vite, single process)
- `npm run sync-data` — sync reports from GCS into `public/data/` (git-ignored)
- `npm run build` — production build (client + SSR server build)
- `npm run build:server` — bundle the Express entry → `build/index.mjs` (run **after** `build`)
- `npm start` — run the production build locally
- `npm run typecheck` — `react-router typegen && tsc`
- `npm run format` — Prettier

Checks worth running before shipping:

```bash
npm run typecheck
npx tsx scripts/phase1-smoke.ts       # data-layer parity + cold/warm cache timings
npx tsx scripts/measure-footprint.ts  # memory/disk footprint of the full dataset
```

> Because SSR pages render on the server, `curl` alone can't prove the app *works* — a broken client
> bundle still returns perfect HTML with dead buttons. Open each route in a browser, confirm the
> console is clean, and click something that needs an event handler.

## Configuration

| Var                      | Default                          | Notes                                                     |
| ------------------------ | -------------------------------- | --------------------------------------------------------- |
| `PORT`                   | `3001`                           |                                                           |
| `E2E_SOURCE`             | `gcs` in prod, `local` otherwise | `gcs` \| `local`; explicit value always wins              |
| `E2E_BUCKET`             | `infra-e2e-test-reports`         | used when the source is `gcs`                              |
| `E2E_CACHE_DIR`          | `./.cache` (`/app/.cache` in the image) | per-run Parquet cache; point at the gcsfuse mount in prod |
| `E2E_WINDOW_DAYS`        | `90`                             | how far back the model reaches; `0` = every run since 2023  |
| `E2E_DUCKDB_TEMP_DIR`    | `<os tmp>/e2e-explorer-duckdb`   | where DuckDB spills; never point this at the cache mount    |
| `E2E_DUCKDB_MEMORY_LIMIT`| (DuckDB default)                 | e.g. `2GB`; set it to fit the container's memory limit      |
| `UV_THREADPOOL_SIZE`     | `8` in the image (`4` otherwise) | must exceed the extraction concurrency, or COPYs starve requests |
| `E2E_WARM_INTERVAL_MS`   | `300000`                         | background re-warm interval; `0` disables re-warming       |
| `E2E_WARM`               | (enabled)                        | set to `0` to disable warming entirely                     |
| `CLUECUMBER_BASE_URL`    | `http://e2e-test-reports.pilot-1`| host serving the per-run Cluecumber HTML reports           |

`E2E_SOURCE` defaults to `gcs` when `NODE_ENV=production` on purpose: the image does **not** contain
`public/data`, so defaulting to the local snapshot there would fail at the first request.

`CLUECUMBER_BASE_URL` is read at **serve** time and handed to the client by the shell loader
(`app/layout.tsx`), so one built image can be deployed to several environments. It deliberately does
*not* go through a `window` global: under SSR there's no `window` while rendering, so the server would
emit the default host in every report link and then mismatch on hydration.

DuckDB's `temp_directory` is set explicitly (`E2E_DUCKDB_TEMP_DIR`) because its default is the process
CWD — the repo root in dev, `/app` in the image, which `USER node` can't write. Spill files can reach
tens of GB, so they belong on local temp, never on the gcsfuse cache mount.

GCS access uses `new Storage()` — Application Default Credentials only, never a hardcoded key.
Locally that's your `gcloud` user; in Cloud Run/GKE it's the attached workload identity.

### Cache on GCS (gcsfuse)

In production the cache directory is a **gcsfuse-mounted bucket**, so it's durable and shared
across instances. The app only ever sees a filesystem path, so nothing app-side needs to change —
but two mount details matter:

- Enable gcsfuse's **`file-cache`**: materializing reads a glob of per-run Parquet files, so a
  local content cache turns repeat reads into local-disk reads.
- The directory must be **writable** (extraction writes `<run_id>.parquet` + a sidecar). This is
  checked once at startup and is **fatal** if it fails: per-run extraction failures are non-fatal by
  design, so an unwritable cache would otherwise boot "fine" and serve zero scenarios everywhere.

There is no other state: the store writes no scratch files, so nothing churns through the mount.

Cached files for runs that have aged out of `E2E_WINDOW_DAYS` are never read again (until someone
deep-links to one), so — like orphaned `CACHE_VERSION/` dirs — they're worth reaping with a GCS
lifecycle rule rather than kept forever. At ~120 KB/run that's slow-growing, not urgent.

## Deployment

`Dockerfile.server` is a multi-stage build producing a single deployable that serves the SSR app.
The builder runs `npm run build` (client + SSR server build) then `npm run build:server` (esbuild →
`build/index.mjs`, a thin Express entry with dependencies kept external), then prunes to production
dependencies. The runtime stage carries `node_modules` + `build/` and runs on `node:24-alpine` as
the non-root `node` user.

> Node deps stay external because the Express entry and the React Router server build must resolve
> the **same** `react-router` copy at runtime. DuckDB publishes musl bindings, so alpine works.

```bash
docker build -f Dockerfile.server -t e2e-explorer .
docker run -p 3001:3001 -e PORT=3001 -e E2E_SOURCE=gcs e2e-explorer
```

In production, attach credentials via workload identity (Cloud Run/GKE) rather than a key file.

### Shipping a local build to Artifact Registry

The registry image is `europe-west4-docker.pkg.dev/hmf-build/hmf-docker/e2e-explorer` (Artifact
Registry, `europe-west4`). Everything is compiled inside the Dockerfile, so no local build first.

1. **Authenticate once per machine:**

   ```bash
   gcloud auth login                                        # if not already logged in
   gcloud auth configure-docker europe-west4-docker.pkg.dev # one-time Docker credential helper
   ```

2. **Bump the version** if this is a new release. Use `npm version` (it updates the lockfile and
   creates a matching `vX.Y.Z` git tag, which the Cloud Build path keys off). It refuses a dirty
   tree, so commit or stash first:

   ```bash
   npm version patch   # 0.5.0 -> 0.5.1  (minor/major for features/breaking)
   ```

3. **Set the image and tag:**

   ```bash
   IMAGE=europe-west4-docker.pkg.dev/hmf-build/hmf-docker/e2e-explorer
   TAG=$(node -p "require('./package.json').version")
   ```

4. **Build.** On Apple silicon add `--platform linux/amd64` to match the runtime:

   ```bash
   docker build -f Dockerfile.server \
     --platform linux/amd64 \
     -t $IMAGE:$TAG -t ${IMAGE}:latest .
   ```

   The braces on `${IMAGE}:latest` are load-bearing in zsh (macOS default): `$IMAGE:latest` is
   parsed as the `:l` lowercase modifier plus a literal `atest`, which silently tags a repo named
   `e2e-exploreratest` instead.

5. **Smoke-test the built image** before pushing:

   ```bash
   docker run --rm -p 3001:3001 -e PORT=3001 $IMAGE:$TAG
   # open http://localhost:3001 — Ctrl-C to stop
   ```

6. **Push both tags:**

   ```bash
   docker push $IMAGE:$TAG
   docker push ${IMAGE}:latest
   ```

7. **Verify:**

   ```bash
   gcloud artifacts docker tags list $IMAGE --project=hmf-build
   ```

### Cloud Build (CI alternative)

A `cloudbuild.yaml` mirroring middle-layer's is included (same image). It bumps the version to
`$TAG_NAME`, then builds and pushes:

```bash
gcloud builds submit --config=cloudbuild.yaml \
  --substitutions=TAG_NAME=$(node -p "require('./package.json').version") \
  --project=hmf-build
```

⚠️ Its `serviceAccount:` is a placeholder copied from middle-layer's — **TODO**: create/verify the
equivalent Cloud Build service account for this repo before relying on it; it hasn't been run. The
local flow above sidesteps that.

## Not done yet (deferred)

- **Not deployed to Cloud Run yet.** The image itself is validated as of 0.6.0: it builds for
  `linux/amd64` (~100 MB compressed, ~364 MB on disk — 202 MB of that is the production
  `node_modules` SSR must ship) and a local smoke test against the live bucket exercised GCS listing,
  download, DuckDB extraction (the alpine musl bindings) and every SSR route as the non-root user.
  What's untested is the deploy: Cloud Run memory sizing (~330 MB RSS with `E2E_WINDOW_DAYS=3`, and
  production defaults to 90) plus the gcsfuse cache mount.
- **No durable cache mirror beyond the mount**: with `E2E_CACHE_DIR` on gcsfuse this is covered, but
  on plain local disk a fresh instance starts cold and re-extracts from the bucket.
- **Dedicated reader service account**: today bucket read rides on the broad project-Viewer grant.
- **Semantic-HTML pass**: pages are data-complete but haven't been audited for full semantics
  (`<th scope>`, `<time>`, …) for machine ingestion.
- **JSON resource routes**: only `/runs/:runId/logs` exists. Loaders already return JSON, so
  exposing more (or `Accept`-header negotiation) is cheap if HTML ingestion proves insufficient.
- **No serialization between reads and rebuilds**: a loader query can overlap a
  `CREATE OR REPLACE TABLE` rebuild. Fine at current scale/usage, but it would matter under real
  concurrency.

See [`docs/ssr-experiment.md`](docs/ssr-experiment.md) for the phased record of the
client-side-SPA → SSR rework, including measurements and the decisions behind this architecture.

Built with React 19 + React Router 8 (SSR) + Vite + Tailwind/shadcn, following patterns from the
[`middle-layer`](../middle-layer) project.
