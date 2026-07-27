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

### Phase 1 — Server data layer (no UI change) — ✅ DONE
- Ported `app/lib/e2e-views.ts` SQL + the STAGE 1/2 extraction logic into
  `server/data/*` on native DuckDB (see "Phase 1 results"). The SQL is imported
  from `e2e-views.ts`, not copied — one source of truth.
- Backed by an on-disk slim-Parquet cache keyed by `run_id` under a
  `SCHEMA_VERSION` dir, with a size_bytes/source sidecar for re-upload detection.
  (GCS `cache/` mirror still TODO — Phase 4.)
- `GcsReportSource` reads the bucket directly (downloads to a temp file); no
  signed URLs for data. Signing stays only for the external Cluecumber links.
- The wasm-OOM fallback is gone (native has real memory) — the full
  scenarios+steps materialization always runs.
- **Not yet done:** the GCS path is implemented but untested here (no creds in
  this env); parity is asserted structurally (see results), not diffed row-for-row
  against a captured WASM run.

### Phase 2 — Turn on SSR — ✅ DONE (dev + local prod; Docker deferred)
- `react-router.config.ts` → `ssr: true`; `@react-router/express`
  `createRequestHandler` wired into `server/index.ts` (Vite middleware in dev,
  the `build/server` build in prod), replacing the static-only catch-all.
- Dev tooling reworked: single `tsx watch server/index.ts` process (Express owns
  Vite middleware + `/api` + `/config.js`); the dev proxy is gone from
  `vite.config.ts`.
- `scripts/build-server.mjs` switched to `packages: "external"` (the shim no
  longer inlines deps); `Dockerfile.server` rewritten to ship a production
  `node_modules` — **not yet built in CI (Phase 5).**
- The app still hydrates for data (routes have no loaders yet) — Phase 3 moves
  data server-side. So a fetched page currently server-renders the layout/shell,
  not the data.

### Phase 3 — Convert routes to loaders — ✅ DONE
- All four routes converted to loaders over the Phase 1 store (3a shell+index,
  3b services, 3c scenarios, 3d runs.$runId). The rolling window is a `?w=` URL
  param read by every loader and the shell; `nightlyOnly` stays a client-side
  filter over loader data. Cross-run analytics run as server SQL; per-view
  filtering/sorting stays client-side JS on loader rows.
- Per-run scenario logs stay lazy via a JSON **resource route**
  (`routes/runs.$runId.logs.tsx`) + `useFetcher`, so they don't bloat run-detail
  SSR.
- Client DuckDB stack deleted: `E2eDataContext`, `DuckDBContext`, `useDuckDB`,
  `report-cache`, `duckdb-query`, `e2e-data`; `@duckdb/duckdb-wasm` dropped.
  Only `RunScopeContext` (the nightly view preference) remains client-side.
- **Bundle win:** the duckdb-wasm client chunk (~264 kB) is gone entirely.
- **Not yet done:** the render is data-complete but not audited for fully
  semantic markup on every view (Phase 3 addendum) — tables are real `<table>`s
  but a pass for `<th scope>`/`<time>` etc. is still open. JSON resource routes
  beyond logs (Phase 3.5) remain deferred.

### Phase 3.5 — JSON resource routes (deferred)
- Only if semantic HTML proves insufficient for ingestion. Loaders already return
  JSON, so exposing `/runs/:runId.json` (or `Accept`-header negotiation) from the
  same loader is near-zero cost. Optionally an `/llms.txt` index.

### Phase 4 — Pre-warm the cache (the speed payoff) — ✅ DONE (startup + interval)
- `server/data/warm.ts`: warms the configured windows (default: the 7-day
  landing window, `E2E_WARM_WINDOWS`) once at startup and every
  `E2E_WARM_INTERVAL_MS` (default 5 min) so the slim cache + materialized tables
  stay hot and loaders hit the ~200 ms warm path.
- Kicked off from `getStore()` and touched at `data.server` module load, so it
  runs in the loaders' module graph (shares the store singleton) — at prod
  startup and on the first dev request. Verified: `[warm] window 0: N runs ready
  in ~190 ms`, then fast requests; browser hydration still clean.
- **Deferred:** streaming/deferred loaders, and a durable GCS `cache/` mirror so
  a fresh Cloud Run instance starts warm instead of re-extracting from the
  bucket (the current warm cache is per-instance local disk, lost on scale-to-
  zero).

### Phase 5 — Measure & ship
- Baseline vs. after: TTFB, LCP/Lighthouse, JS bytes shipped, warm/cold loader
  timings.
- Dockerfile: new base image, native duckdb external, Cloud Run memory sizing
  (native DuckDB + Parquet cache needs headroom).
- **Add a real browser hydration check to the acceptance tests.** The `curl`
  smoke tests only assert the *server* HTML; they cannot catch a broken client
  (e.g. the dev `504 Outdated Optimize Dep` that left pages rendered but
  un-hydrated — fast loads, dead buttons). Every route must be opened in a
  browser with (a) a clean console and (b) one real interaction that requires an
  attached handler (a metric toggle / expand / search), in BOTH dev and a
  production build. This gap let a hydration regression ship past the smoke
  tests once already.

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

## Phase 1 results

`server/data/`: `engine.ts` (native DuckDB singleton + BigInt-safe row
normalizer), `sources.ts` (LOCAL + GCS report sources), `slim-cache.ts`
(on-disk slim Parquet, extract-on-miss, atomic rename + sidecar), `store.ts`
(`refresh(since)` → materialize runs/scenarios/steps/test_ids/service_versions,
`query<T>()`). `@duckdb/node-api` promoted to a runtime dependency.

`scripts/phase1-smoke.ts` over the 60 local synthetic runs (offline):

- **Cold** refresh (extract every run): 60 runs / ~688 ms (~11 ms/run) →
  1801 scenarios, 68 765 steps, 3438 service-version rows.
- **Warm** refresh (all slim Parquet cached): 60 runs / ~238 ms.
- **Parity clean:** every run whose id encodes `failed-N-of-M` has computed
  failed-scenario count == N (15 such runs, 0 mismatch); every run's scenarios
  agree on the services block (`distinct_blocks = 1` throughout).

Typecheck (`npm run typecheck`) passes. The Phase 0 spike script was removed —
`phase1-smoke.ts` supersedes it.

## Phase 2 results

- `npm run typecheck` passes.
- `npm run build` emits both `build/client` and `build/server/index.js`;
  `npm run build:server` emits the 7.8 kb `build/index.mjs` shim.
- **Dev SSR** (`npm run dev`): `/`, `/scenarios`, `/services`, `/runs/:id` all
  return 200 with server-rendered layout markup ("E2E Explorer", nav) in the raw
  HTML and no render errors in the log.
- **Local prod SSR** (`npm start`): boots `Mode: production (SSR)`, serves
  server-rendered HTML referencing `/assets/entry.client-*.js`, and serves that
  fingerprinted asset with a 200 + `text/javascript`.
- **Not validated here:** the Docker image build and Cloud Run deploy (Phase 5).

## Phase 5 results (local; deploy + measurement on real hw still pending)

Done headlessly:
- **Prod entrypoint verified.** `node build/index.mjs` (the exact Docker CMD)
  boots `Mode: production (SSR)`, warms window 0 (~140 ms), and serves every
  route + the logs resource route (all 200). Note the build is two steps:
  `react-router build` (client+server) **then** `npm run build:server` (the
  esbuild shim `build/index.mjs`) — the first wipes `build/`, so run both (the
  Dockerfile does).
- **Browser hydration acceptance pass** (production build, all routes): clean
  console + a handler-dependent interaction each — dashboard (date-range
  popover, nightly↔all re-filter 2→4 runs), scenarios (metric toggle), services
  (show/hide unchanged), run detail (expand scenario → steps/log controls).
- **Caught + fixed a hydration mismatch (React #418):** `RunScopeContext` read
  `localStorage` during render, so the client's first render (stored "all runs")
  diverged from the server default (nightly) — masked, since React silently
  re-rendered. Now defaults on both sides and adopts the stored value in an
  effect. Also killed the `/favicon.ico` 404 with an inline icon. This is
  exactly the class of bug `curl` can't see (see the Phase 5 note above).
- **Bundle measurement (both production builds):** client JS **205 KB → 154 KB
  gzip (~25% less)**; the SPA's largest chunk was duckdb-wasm (64 KB gzip), now
  gone. The delta understates the real first-load win: the SPA additionally
  fetched the multi-MB DuckDB **WASM binary** (CDN) and every run's report JSON
  at runtime — all eliminated.

Still blocked / pending (needs your environment):
- **Docker image build** — the local Docker daemon isn't running, so the alpine
  + musl-native-duckdb image is unbuilt/unvalidated.
- **Cloud Run deploy + real A/B** (TTFB / LCP / warm-vs-cold on real hardware).
- Cloud Run memory sizing for native DuckDB + the Parquet cache.

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
