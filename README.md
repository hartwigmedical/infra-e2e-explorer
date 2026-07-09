# e2e-explorer

A browser-based explorer for the Cucumber end-to-end test results produced by the
[`verification`](../verification) suite. It answers two questions the per-run Cluecumber
HTML reports can't:

1. **What do the most recent runs look like?** — a dashboard of runs with status, failed/total,
   per-run scenario pass/fail/skip counts, and a nightly pass-rate trend.
2. **When did a given scenario / step start failing?** — a cross-run history strip per scenario
   and a step × run grid, so regressions are obvious at a glance.

## How it works

Pure client-side SPA — **no backend, no build pipeline, no Parquet**. It loads the raw
`cucumber.json` reports at runtime with **DuckDB-Wasm** and exposes the deeply-nested Cucumber
JSON as clean SQL over `read_json` + `UNNEST` (see `app/lib/e2e-views.ts`):

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
npm run dev           # http://localhost:5173
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

## Not done yet (deferred)

- **Live data** (beyond the local window): the same `read_json(url)` views can point at remote
  URLs once the bucket is served with CORS (e.g. the internal `e2e-test-reports.pilot-1` service)
  or via a small proxy. The bucket is not directly browser-readable today (no CORS,
  `public_access_prevention=enforced`).
- **Persistent cache**: if the window grows large enough that runtime parsing is slow, persist
  the materialized tables (DuckDB OPFS file) instead of re-parsing each session.
- **More filters**: date-range and tag filters (nightly-only, feature, search, and failures-only
  are implemented).

Built on the DuckDB-Wasm patterns from the [`middle-layer`](../middle-layer) project (React 19 +
React Router 7/8 SPA + Vite + Tailwind/shadcn).
