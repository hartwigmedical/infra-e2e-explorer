# e2e-explorer

> ⚠️ **Disclaimer:** this project is ~99% vibe-coded — built almost entirely through
> AI prompting / pair-programming rather than hand-written line by line. Treat it
> accordingly and review before relying on it.

A browser-based explorer for the Cucumber end-to-end test results produced by the
[`verification`](../verification) suite. It answers two questions the per-run Cluecumber
HTML reports can't:

1. **What do the most recent runs look like?** — a dashboard of runs with status, failed/total,
   per-run scenario pass/fail/skip counts, and a nightly pass-rate trend.
2. **When did a given scenario / step start failing?** — a cross-run history strip per scenario
   and a step × run grid, so regressions are obvious at a glance.

## How it works

Client-side SPA — no build pipeline. It reads the `cucumber.json` reports at runtime with
**DuckDB-Wasm** and exposes the deeply-nested Cucumber JSON as clean SQL over `read_json` +
`UNNEST` (see `app/lib/e2e-views.ts`):

- `v_runs` — one row per run, derived from the run-folder name (`runs.json`); no report parsing.
- `v_features` / `v_scenarios` / `v_steps` — features → scenarios → steps, unnested.

On load these are **materialized once into in-memory DuckDB tables** (`runs`, `scenarios`,
`steps`) so every navigation is instant instead of re-querying. The runs table is ready almost
immediately (folder names only); scenario/step details finish a moment later. Reports are read
same-origin from `public/data/` (dev server), so there's no CORS or auth to deal with locally.

**Per-run slim cache (fast repeat loads).** A raw report is ~90% base64 embedding blobs the app
mostly doesn't need. So each run's report is parsed exactly once into a compact "slim" Parquet —
the feature/scenario/step structure with those blobs stripped, but keeping the decoded `text/plain`
scenario **log** (a ~9 MB report → ~150 KB) — which is cached in **IndexedDB** keyed by the
immutable `run_id` (see `app/lib/report-cache.ts`). A repeat session or `loadMore` registers the
cached Parquet straight into DuckDB (no fetch, no parse) and only pays for genuinely new runs; a
warm window does zero report I/O. All analysis (`v_scenarios`/`v_steps`/`test_ids`/`service_versions`),
**and** the run-detail Log button, run over the slim Parquet — so once a run is cached nothing
ever re-reads the raw JSON.

> Why IndexedDB and not OPFS: the app is deployed over plain HTTP on an internal host, which is
> not a secure context — OPFS, the Cache API and `navigator.storage` are all unavailable there,
> but IndexedDB works. Cache staleness is handled by `SCHEMA_VERSION` (a hash of the extraction
> schema): change the _set of raw fields extracted_ and every client's cache self-clears on next
> load; changing only _analysis_ logic needs no invalidation, since that re-runs over the cache.

> Note: the slim extraction uses an explicit `columns=` schema rather than `read_json`
> auto-detection — auto-detection OOMs the wasm heap across dozens of files. Explicit typing also
> sidesteps schema drift between report eras. The schema pulls the `text/plain` embedding's `data`
> so the log can be decoded at parse time, but `buildSlimSelectSql` stores only the decoded string
> and drops every base64 blob — so the huge screenshot/video zips are read transiently (one report
> at a time, bounding parse memory) yet never land in the slim Parquet.

**Service versions (deployment tracking).** Every scenario's log embeds a `Running services:`
block (`service = image:tag` for each deployment in the cluster the run tested against). Because
the log is stored in the slim Parquet (above), we parse that block as plain **analysis over the
cached slim data** — like `test_ids`, not a separate read of the raw report — into a per-run
`(service, image, version, …)` set (see `app/lib/e2e-views.ts` `buildServiceVersionsSelectSql`).
It's surfaced on the run-detail page as "what was deployed" plus a diff against the previous run,
so a failure can be lined up with a deployment (`app/components/ServiceVersions.tsx`). The scenarios
in a run agree on their versions in practice (validated across all local reports); the rare
disagreement is surfaced with a disclaimer rather than modelled per-scenario. Only the version
block is read — the rest of each log (which carries synthetic patient/hospital ids) is ignored.

## Quick start

Prerequisites: Node (npm ≥ 11.10 for the `min-release-age` policy) and `gcloud` authenticated
with read access to `gs://infra-e2e-test-reports`.

```bash
npm install
npm run sync-data     # copies the ~60 most recent runs into public/data/ + writes runs.json
npm run dev           # client on http://localhost:5177, API server on http://localhost:3001
```

`sync-data` is idempotent (skips runs already downloaded; `--force` to re-fetch). Fetch a
different window with `N=120 npm run sync-data`.

## Routes

| Route          | What it shows                                                             |
| -------------- | ------------------------------------------------------------------------- |
| `/`            | Recent Runs dashboard (status, failed/total, scenario counts, trend)      |
| `/runs/:runId` | Run detail — features → scenarios → steps, failures surfaced, step errors |
| `/scenarios`   | Scenario history — cross-run pass/fail strip + step × run grid            |

## Data source

`gs://infra-e2e-test-reports` — one folder per run, named
`YYYY-MM-DD[-HHMM][-ok|-failed][-N-of-M]`. `-0200-` folders are the scheduled nightly full runs;
odd-time folders are manual re-runs (`is_nightly=false`, filtered out of history by default).
Current-era reports are `cucumber-parallel.json`; pre-2025 are `cucumber.json` (the sync script
normalizes both to `cucumber.json` locally). This is **synthetic** test-infrastructure data.

The reports' large base64 embedding blobs (screenshot/video zips) are **deliberately excluded**
from the data model — nothing loads or renders them. The one exception is each scenario's
`text/plain` log, which is decoded at extraction time and kept (see the slim cache above); it
drives the Log button and service-versions parsing.

## Scripts

- `npm run dev` — dev server
- `npm run sync-data` — sync reports from GCS into `public/data/` (git-ignored)
- `npm run build` — production SPA build
- `npm run typecheck` — `react-router typegen && tsc`
- `npm run format` — Prettier

## Live data & deployment

A tiny Express server (`server/index.ts`) lets the app serve **live** data straight from GCS
instead of the local `sync-data` snapshot: it lists run folders in the bucket and hands back V4
signed URLs so DuckDB-Wasm can `read_json` each run's Cucumber report directly from
`storage.googleapis.com` (with HTTP Range support), no proxy download involved.

### `GET /api/runs`

```
GET /api/runs?since=2026-07-15      # windowed (what the app uses)
GET /api/runs?limit=60&offset=0     # legacy paged
```

`since` (a `YYYY-MM-DD` cutoff, the mode the client uses) lists **only** run folders in that
window, bounded with GCS `startOffset` rather than enumerating the whole bucket — so the cost
scales with the window, not the bucket's total history. Because that means the whole bucket is
never counted, `total` in a `since` response is **not** the grand total: it's `runs.length` plus
1 when any run exists older than `since`, which is all the client needs (it uses `total` only to
decide whether "Load more"/a wider window would reveal older runs). The legacy `limit`/`offset`
path still enumerates the full bucket and returns the real grand total.

```json
{
  "total": 1156,
  "limit": 60,
  "offset": 0,
  "runs": [
    {
      "run_id": "2026-07-09-0200-failed-2-of-42",
      "source": "cucumber-parallel.json",
      "size_bytes": 7340490,
      "updated": "2026-07-09T02:09:28.935Z",
      "cucumberUrl": "https://storage.googleapis.com/infra-e2e-test-reports/2026-.../cucumber-parallel.json?X-Goog-Algorithm=..."
    }
  ]
}
```

- `runs` is sorted **newest-first** (`run_id` descending).
- `limit` defaults to 60 (max 500), `offset` defaults to 0.
- If signed-URL generation isn't available (see below), `cucumberUrl` is `null` for every run and
  the response carries a top-level `"warning": "signing unavailable: <reason>"` instead of
  failing the whole request — the run list still works.
- `GET /api/health` → `{ "ok": true }`.

### Env vars

| Var                      | Default                  |
| ------------------------ | ------------------------ |
| `PORT`                   | `3001`                   |
| `E2E_BUCKET`             | `infra-e2e-test-reports` |
| `SIGNED_URL_TTL_SECONDS` | `900`                    |

The server uses `new Storage()` — Application Default Credentials only, never a hardcoded key or
service account. Locally that's your `gcloud` user; in Cloud Run/GKE it's the attached workload
identity service account.

### Signing locally

V4 signing needs a credential that can call the IAM `signBlob` API — a plain user ADC (e.g. after
`gcloud auth application-default login`) **cannot** sign and the server will fall back to the
`cucumberUrl: null` + `warning` path described above (this is expected and the run list still
works). To get real signed URLs locally, impersonate a service account that has read access to
the bucket and has `roles/iam.serviceAccountTokenCreator` on itself (or granted to you):

```bash
gcloud auth application-default login \
  --impersonate-service-account=<SA_WITH_BUCKET_READ_AND_TOKEN_CREATOR>@hmf-pipeline-development.iam.gserviceaccount.com
```

> Read access to `gs://infra-e2e-test-reports` in this project is currently granted via the
> legacy `roles/storage.legacyBucketReader`/`legacyObjectReader` bindings on
> `projectViewer:hmf-pipeline-development` — i.e. any principal (or service account) with at
> least Viewer on the `hmf-pipeline-development` project can read the bucket. There's no
> dedicated "e2e-reports-reader" service account yet; one should be created (bucket-scoped
> `roles/storage.objectViewer` + self-granted `roles/iam.serviceAccountTokenCreator`) for both
> local impersonation and the Cloud Run/GKE runtime identity, rather than relying on the broad
> project-Viewer grant.

### Bucket CORS

DuckDB-Wasm reads each report with HTTP Range requests, so the bucket needs CORS with
`Range`/`Content-Range`/`Accept-Ranges` exposed. Apply the config in `deploy/cors.json`:

```bash
gcloud storage buckets update gs://infra-e2e-test-reports --cors-file=deploy/cors.json
```

Edit `deploy/cors.json` first and replace `https://REPLACE_WITH_PROD_ORIGIN` with the real prod
origin once the app is deployed.

### Docker

`Dockerfile.server` is a multi-stage build producing a single deployable that serves the static
client build **and** `/api`. The builder compiles the client (`npm run build`) and bundles the
Express server into one self-contained file (`npm run build:server` → esbuild → `build/index.mjs`,
with `express`/`cors` inlined and `@google-cloud/storage` kept external). The runtime stage then
carries only that bundle, the static client, and a minimal install of the one external dep — so
it doesn't ship the ~250 MB of client-only libraries (duckdb-wasm, react, lucide, …) that the
server never uses. It runs on `node:24-alpine` **as the non-root `node` user** (~240 MB image).

Quick local smoke test (no push):

```bash
docker build -f Dockerfile.server -t e2e-explorer .
docker run -p 3001:3001 -e PORT=3001 e2e-explorer
```

In production, mount/attach credentials via workload identity (Cloud Run/GKE) rather than a key
file — the server never expects one.

### Shipping a local build to Artifact Registry

The registry image is `europe-west4-docker.pkg.dev/hmf-build/hmf-docker/e2e-explorer` (Artifact
Registry, `europe-west4`). Everything is compiled inside the Dockerfile (`npm ci && npm run build
&& npm run build:server`), so you don't need a local `npm` build first — just run these from the
repo root.

1. **Authenticate once per machine** (Docker → Artifact Registry, plus your gcloud login):

   ```bash
   gcloud auth login                                        # if not already logged in
   gcloud auth configure-docker europe-west4-docker.pkg.dev # one-time Docker credential helper
   ```

2. **Bump the version** if this is a new release, so you don't overwrite an existing tag. Use
   `npm version` rather than editing `package.json` by hand — it updates the lockfile and creates a
   matching `vX.Y.Z` git tag (which is also what the Cloud Build path keys off). It refuses to run
   with a dirty tree, so commit or stash first:

   ```bash
   npm version patch   # 0.4.5 -> 0.4.6  (minor/major for features/breaking; or pass an exact version)
   ```

3. **Set the image and tag.** Tag with the `package.json` version so the pushed tag matches the
   release:

   ```bash
   IMAGE=europe-west4-docker.pkg.dev/hmf-build/hmf-docker/e2e-explorer
   TAG=$(node -p "require('./package.json').version")   # e.g. 0.4.6
   ```

4. **Build.** Pass `SHORT_SHA` for provenance. On Apple silicon add `--platform linux/amd64` so the
   image matches the amd64 runtime:

   ```bash
   docker build -f Dockerfile.server \
     --platform linux/amd64 \
     --build-arg SHORT_SHA=$(git rev-parse --short HEAD) \
     -t $IMAGE:$TAG -t $IMAGE:latest .
   ```

5. **Smoke-test the built image** before pushing:

   ```bash
   docker run --rm -p 3001:3001 -e PORT=3001 $IMAGE:$TAG
   # open http://localhost:3001 — Ctrl-C to stop
   ```

6. **Push both tags:**

   ```bash
   docker push $IMAGE:$TAG
   docker push $IMAGE:latest
   ```

7. **Verify the push landed:**

   ```bash
   gcloud artifacts docker tags list $IMAGE --project=hmf-build
   ```

### Cloud Build (CI alternative)

A `cloudbuild.yaml` mirroring middle-layer's is included (same image). It bumps the version to
`$TAG_NAME`, then builds and pushes. Trigger it manually with:

```bash
gcloud builds submit --config=cloudbuild.yaml \
  --substitutions=TAG_NAME=$(node -p "require('./package.json').version"),SHORT_SHA=$(git rev-parse --short HEAD) \
  --project=hmf-build
```

⚠️ Its `serviceAccount:` is a placeholder copied from middle-layer's — **TODO**: create/verify the
equivalent Cloud Build service account for this repo before relying on it; it hasn't been run. The
local flow above sidesteps that.

## Not done yet (deferred)

- **Dedicated reader service account**: see the "Signing locally" note above — today bucket read
  rides on the broad project-Viewer grant instead of a purpose-built SA.
- **More filters**: date-range and tag filters (nightly-only, feature, search, and failures-only
  are implemented).
- **Server-side slim derivation**: the per-run slim Parquet is computed client-side and cached in
  IndexedDB (see "Per-run slim cache" above), so a _cold_ load still downloads full raw reports.
  Precomputing the slim Parquet server-side (derive-once into GCS, sign those URLs) would cut the
  cold-load download too — the client cache already covers warm loads and `loadMore`.
- **Service-versions timeline (Phase 2)**: the per-run service versions (see "Service versions"
  above) are so far surfaced only on run detail. A dedicated services × runs view — each service's
  version history across runs, with change points highlighted — would answer "what changed
  between runs" at a glance and make regressions line up with deployments across the whole window.

Built on the DuckDB-Wasm patterns from the [`middle-layer`](../middle-layer) project (React 19 +
React Router 7/8 SPA + Vite + Tailwind/shadcn).
