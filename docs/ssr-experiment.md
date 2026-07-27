# SSR experiment — moving e2e-explorer server-side

Status: **experiment**, on branch `ssr-experiment`. `main` keeps the current SPA
so the two can be compared side by side.

## Goals

1. **Faster page loads.** Kill the browser-side DuckDB-WASM download + per-client
   report fetching/parsing that today block the first useful paint.
2. **LLM/agent-ingestible pages.** A plain fetch of a page (what an LLM, crawler,
   or `curl` sees) must contain the real data, not an empty SPA shell.

Both are delivered by the same move: run DuckDB, report parsing, and the
analytical queries on the server, and render HTML (with the data already in it)
via React Router SSR.

## Where we are today

An SPA (`react-router.config.ts` → `ssr: false`). The Express server is thin:
it lists GCS run folders (`/api/runs`) and hands the browser **signed URLs**.
Everything else is client-side:

- DuckDB-**WASM** downloaded + instantiated in the browser (large; blocks paint).
- Browser fetches each run's raw Cucumber JSON (90%+ base64 blobs), parses to a
  compact "slim" Parquet, caches it in **IndexedDB** keyed by `run_id`.
- Two-stage materialization (`runs` → `scenarios`/`steps`/`test_ids`/
  `service_versions`), with a **wasm-OOM fallback** path.
- Every analytical query runs in-browser across 4 data-heavy routes
  (`runs.$runId` alone is ~2000 lines / 41 hooks).

Consequence for both goals: first load pays for WASM + N report fetches + N
parses before anything useful appears (and repeats per browser), and a fetched
page is an empty `<div id="root">` until that JS runs.

## Target architecture

| Concern | Today (client) | After (server) |
|---|---|---|
| Query engine | DuckDB-WASM in browser | **Native DuckDB** in Node (`@duckdb/node-api`) |
| Report fetch | Browser via signed URLs | Server reads the bucket directly (already has the handle) |
| Slim-Parquet cache | IndexedDB, **per client** | On-disk cache, **shared**; optionally mirrored to a GCS `cache/` prefix |
| Analytics | `useE2eQuery` in components | React Router **loaders** returning plain JSON |
| Client JS | DuckDB + contexts + cache logic | Presentational components + cheap in-memory filter/sort |

The existing model translates almost 1:1 — the slim-Parquet-per-run cache keyed
by `run_id` and versioned by `SCHEMA_VERSION` stays; it just moves from IndexedDB
to disk and becomes shared. Loaders query the cached Parquet with
`read_parquet([...window...])`, mirroring today's `buildFeaturesViewSql`.

## The decisive tradeoff

Moving report fetch+parse server-side puts it **in the request path**. Warm cache
→ very fast (real HTML, no WASM). **Cold** cache → the loader must fetch+parse
from GCS before responding, which can be *slower* than today's progressive
render. So **cache pre-warming is not optional** — it's what delivers the speed
goal. On Cloud Run (scale-to-zero, ephemeral disk) a fresh instance starts cold,
so the cache should be durable in GCS and/or warmed at startup.

## Phases

### Phase 0 — De-risk (throwaway spike) — ✅ DONE
- Native DuckDB (`@duckdb/node-api`) runs the real slim-extraction SQL and
  `read_parquet(glob)` reproduces current query results. See "Phase 0 results".
- The native `.node` binary must stay **external** to the esbuild server bundle,
  and its platform-matched optional dep (`@duckdb/node-bindings-*`) must be
  installed in the runtime image.

### Phase 1 — Server data layer (no UI change)
- Port `app/lib/e2e-views.ts` SQL + the STAGE 1/2 extraction logic out of
  `E2eDataContext` into `server/data/*`, using native DuckDB.
- Back it with an on-disk slim-Parquet cache (keyed by `run_id`, versioned by
  `SCHEMA_VERSION`); optional GCS `cache/` mirror so Cloud Run instances share
  warmth.
- Server reads reports directly from the bucket — **signed URLs for data go
  away**; keep signing only for the external Cluecumber HTML links.
- Parity-test: same runs → same rows as the WASM path. The wasm-OOM fallback
  disappears (native has real memory).

### Phase 2 — Turn on SSR
- `react-router.config.ts` → `ssr: true`; wire `@react-router/express`
  `createRequestHandler` into `server/index.ts`, replacing the static-only
  catch-all.
- Rework dev tooling: the `run-p dev:client dev:server` split changes (Express
  becomes the entry with the RR Vite middleware). Touches `package.json` +
  `vite.config.ts`.

### Phase 3 — Convert routes to loaders (index → services → scenarios → runs.$runId)
- Move each `useE2eQuery` into the route loader. Classify every query:
  *must be server SQL* (cross-run analytics) vs *cheap client filter/sort* (do in
  JS on loader data — no engine client-side). Keeps interactions snappy instead
  of turning every filter into a round-trip.
- URL-param-driven window/tag filters so loaders re-run server-side and links are
  shareable.
- **Render semantic HTML** (real `<table>`/`<th>`/`<time>`/headings) so the pages
  are cleanly ingestible.
- Once all four are migrated, delete `E2eDataProvider`, `DuckDBContext`,
  `useDuckDB`, `report-cache`, `duckdb-query`, and drop `@duckdb/duckdb-wasm` — a
  large bundle win.

### Phase 3.5 — JSON resource routes (deferred)
- Only if semantic HTML proves insufficient for ingestion. Loaders already return
  JSON, so exposing `/runs/:runId.json` (or `Accept`-header negotiation) from the
  same loader is near-zero cost. Optionally an `/llms.txt` index.

### Phase 4 — Pre-warm the cache (the speed payoff)
- Repurpose `scripts/sync-reports.mjs` into a startup + periodic warmer for the
  default (7-day) and common windows. Consider streaming/deferred loaders so a
  fast query paints while a slow one resolves. Doubly important now — a cold
  cache hurts both humans and ingestion clients.

### Phase 5 — Measure & ship
- Baseline vs. after: TTFB, LCP/Lighthouse, JS bytes shipped, warm/cold loader
  timings.
- Dockerfile: new base image, native duckdb external, Cloud Run memory sizing
  (native DuckDB + Parquet cache needs headroom).

## Phase 0 results

Ran `scripts/spike-native-duckdb.ts` (imports the real SQL builders from
`app/lib/e2e-views.ts`) against local synthetic reports, native DuckDB
`@duckdb/node-api@1.5.4-r.1`:

- **Native engine runs the real pipeline.** `read_json` over raw `cucumber.json`
  + base64 log decode + `COPY … TO … (FORMAT parquet)`: 6/6 sampled runs, ~17
  ms/run.
- **`read_parquet(GLOB)` reproduces the views.** `v_scenarios` / `v_steps` /
  `test_ids` / `service_versions` all materialized over a `slim_*.parquet` glob;
  all analytical queries ran in ~2 ms. Results are faithful — each run's
  `failed-N-of-M` id matches its computed failed-scenario count; service-version
  extraction yields 58 services with `distinct_blocks = 1` (as e2e-views.ts
  predicts).
- **Alpine likely stays.** DuckDB publishes **musl** bindings
  (`@duckdb/node-bindings-linux-x64-musl`, `…-arm64-musl`), so no glibc/base-image
  switch is forced — the Dockerfile just needs the platform-matched optional dep
  present in the runtime stage (installed for the target `--os`/`--cpu`/`--libc`,
  or built on a matching image), kept external to the esbuild bundle.

Net: both risks cleared; Phase 1 can proceed. (The `@duckdb/node-api` devDep and
`scripts/spike-native-duckdb.ts` are the throwaway spike — keep until Phase 1
promotes the engine to a real dependency, then remove the script.)

## Guardrails

- All work on the `ssr-experiment` branch; `main`'s SPA stays live for A/B.
- Data is confirmed synthetic test-infra data (see `scripts/sync-reports.mjs`) —
  no PII handling concerns.
- Success bar to lock before committing: warm first-load meaningfully beats today
  on a mid/low-power client, and cold load stays under a defined ceiling.

## Open questions

- Persistent in-memory materialized tables vs. per-request `read_parquet` glob?
  (Leaning per-request for statelessness; DuckDB native is fast. Revisit under
  load.)
- GCS `cache/` mirror format + invalidation on `SCHEMA_VERSION` bump.
- Cloud Run memory/CPU sizing for the native engine + cache.
