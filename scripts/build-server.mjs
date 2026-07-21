#!/usr/bin/env node
/**
 * Bundle the Express server (server/index.ts) into a single self-contained ESM
 * file at build/index.mjs, so the production Docker image doesn't have to ship
 * node_modules for it.
 *
 * express and cors are inlined; @google-cloud/storage is kept EXTERNAL (it does
 * dynamic requires / ships asset files that don't bundle reliably, and its
 * code paths - bucket listing, V4 signing - can't be fully exercised without
 * GCS credentials, so we don't want a latent bundling bug surfacing only in
 * prod). Dockerfile.server installs just that one dep into the runtime image.
 *
 * Output goes to build/index.mjs (a SIBLING of build/client) on purpose: the
 * server resolves the static client via `path.resolve(import.meta.dirname,
 * "../build/client")`, and from /app/build that resolves back to
 * /app/build/client. See Dockerfile.server.
 */
import { build } from "esbuild";

await build({
  entryPoints: ["server/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  outfile: "build/index.mjs",
  external: ["@google-cloud/storage"],
  // Bundled CJS deps (express/cors) may hit a runtime `require`; define one in
  // the ESM output so those calls resolve instead of throwing.
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  logLevel: "info",
});
