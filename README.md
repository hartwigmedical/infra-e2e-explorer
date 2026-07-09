# e2e-explorer

A browser-based explorer for the Cucumber end-to-end test results produced by the
[`verification`](../verification) suite. It answers two questions the per-run Cluecumber
HTML reports can't:

1. **What do the most recent runs look like?** — a dashboard of runs with status, failed/total,
   per-run scenario pass/fail/skip counts, and a nightly pass-rate trend.
2. **When did a given scenario / step start failing?** — a cross-run history strip per scenario
   and a step × run grid, so regressions are obvious at a glance.

## How it works

Client-side SPA — no build pipeline, no Parquet. It loads the raw `cucumber.json` reports at
runtime with **DuckDB-Wasm** and exposes the deeply-nested Cucumber JSON as clean SQL over
`read_json` + `UNNEST` (see `app/lib/e2e-views.ts`):

- `v_runs` — one row per run, derived from the run-folder name (`runs.json`); no report parsing.
- `v_features` / `v_scenarios` / `v_steps` — features → scenarios → steps, unnested.

On load the views are **materialized once into in-memory DuckDB tables** (`runs`, `scenarios`,
`steps`) so every navigation is instant instead of re-reading ~270 MB of JSON per query. The
runs table is ready almost immediately (folder names only); scenario/step details finish a
moment later. Reports are read same-origin from `public/data/` (dev server), so there's no CORS
or auth to deal with locally.

> Note: `v_features` uses an explicit `columns=` schema rather than `read_json` auto-detection —
> auto-detection OOMs the wasm heap across dozens of files. Explicit typing also sidesteps
> schema drift between report eras.

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

| Route             | What it shows                                                             |
| ----------------- | ------------------------------------------------------------------------- |
| `/`               | Recent Runs dashboard (status, failed/total, scenario counts, trend)      |
| `/runs/:runId`    | Run detail — features → scenarios → steps, failures surfaced, step errors |
| `/scenarios`      | Scenario history — cross-run pass/fail strip + step × run grid            |

## Data source

`gs://infra-e2e-test-reports` — one folder per run, named
`YYYY-MM-DD[-HHMM][-ok|-failed][-N-of-M]`. `-0200-` folders are the scheduled nightly full runs;
odd-time folders are manual re-runs (`is_nightly=false`, filtered out of history by default).
Current-era reports are `cucumber-parallel.json`; pre-2025 are `cucumber.json` (the sync script
normalizes both to `cucumber.json` locally). This is **synthetic** test-infrastructure data.

Attachment/embedding blobs in the reports (base64 logs) are **deliberately excluded** from the
data model — nothing in the app loads or renders them.

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
GET /api/runs?limit=60&offset=0
```

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

| Var                       | Default                    |
| ------------------------- | --------------------------- |
| `PORT`                    | `3001`                       |
| `E2E_BUCKET`               | `infra-e2e-test-reports`     |
| `SIGNED_URL_TTL_SECONDS`   | `900`                         |

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

`Dockerfile.server` is a multi-stage build: it builds the client (`npm run build`) then runs the
Express server (serving the static client build **and** `/api`) in a slim `node:24-alpine` image
— a single deployable, mirroring `middle-layer/Dockerfile.server`.

```bash
docker build -f Dockerfile.server -t e2e-explorer .
docker run -p 3001:3001 -e PORT=3001 e2e-explorer
```

In production, mount/attach credentials via workload identity (Cloud Run/GKE) rather than a key
file — the server never expects one.

A `cloudbuild.yaml` mirroring middle-layer's is included (image
`europe-west4-docker.pkg.dev/hmf-build/hmf-docker/e2e-explorer`), but its `serviceAccount:` is a
placeholder copied from middle-layer's — **TODO**: create/verify the equivalent Cloud Build
service account for this repo before relying on it; it hasn't been run.

## Not done yet (deferred)

- **Dedicated reader service account**: see the "Signing locally" note above — today bucket read
  rides on the broad project-Viewer grant instead of a purpose-built SA.
- **Persistent cache**: if the window grows large enough that runtime parsing is slow, persist
  the materialized tables (DuckDB OPFS file) instead of re-parsing each session.
- **More filters**: date-range and tag filters (nightly-only, feature, search, and failures-only
  are implemented).

Built on the DuckDB-Wasm patterns from the [`middle-layer`](../middle-layer) project (React 19 +
React Router 7/8 SPA + Vite + Tailwind/shadcn).
