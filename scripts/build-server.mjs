#!/usr/bin/env node
/**
 * Bundle the Express server (server/index.ts) into a single ESM entry at
 * build/index.mjs. Under SSR this is a thin shim: it wires Express to the React
 * Router request handler and loads the SEPARATE server build produced by
 * `react-router build` (build/server/index.js) at runtime.
 *
 * `packages: "external"` keeps every node_modules dependency out of the bundle:
 * with SSR the runtime image already needs the app's deps (react, react-dom,
 * react-router, …) present for the RR server build, and both this shim and that
 * build must resolve to the SAME react-router copy - so bundling would be wrong,
 * not just wasteful. Native/asset-heavy deps (@duckdb/node-api,
 * @google-cloud/storage) and dev-only vite stay external for the same reason.
 * The runtime image therefore ships a production node_modules (see
 * Dockerfile.server - updated in Phase 5).
 *
 * Output goes to build/index.mjs (a SIBLING of build/client and build/server):
 * the server resolves both via `path.resolve(import.meta.dirname, "../build/…")`.
 */
import { build } from "esbuild";

await build({
  entryPoints: ["server/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: "build/index.mjs",
  packages: "external",
  // Bundled CJS deps (express/cors) may hit a runtime `require`; define one in
  // the ESM output so those calls resolve instead of throwing.
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "info",
});
