/**
 * Express host for the React Router SSR app.
 *
 * This is deliberately thin: it serves the runtime config script, the built
 * client assets, and hands everything else to the React Router request handler.
 * All data access lives in the route loaders (see app/lib/data.server.ts ->
 * server/data/*), which read the reports bucket directly - so there is no
 * data API and no signed-URL generation here any more.
 */

import express from "express";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequestHandler } from "@react-router/express";

// ---------- config ----------

const PORT = Number(process.env.PORT) || 3001;

// Host serving the Cluecumber HTML reports. Differs per environment, so it's a
// runtime var (not build-time) — one built client bundle is shared across
// deployments. The app reads it through the shell loader (app/layout.tsx), which
// runs on the server; this is only for the startup banner below.
const CLUECUMBER_BASE_URL =
  process.env.CLUECUMBER_BASE_URL || "http://e2e-test-reports.pilot-1";

const isProd = process.env.NODE_ENV === "production";

// ---------- app ----------

const app = express();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// ---------- React Router SSR ----------
// The routes above are registered first, so they win over the SSR catch-all.

if (isProd) {
  // Built client: fingerprinted /assets are immutable; the rest gets a short
  // cache. The SSR handler renders every non-asset request.
  const clientDir = path.resolve(import.meta.dirname, "../build/client");
  app.use(
    "/assets",
    express.static(path.join(clientDir, "assets"), {
      immutable: true,
      maxAge: "1y",
    }),
  );
  app.use(express.static(clientDir, { maxAge: "1h" }));

  // The server build from `react-router build`, a sibling of this file's build
  // dir. A variable specifier keeps esbuild from trying to bundle it (it's
  // produced separately - see scripts/build-server.mjs).
  const serverBuildPath = path.resolve(
    import.meta.dirname,
    "../build/server/index.js",
  );
  const build = await import(pathToFileURL(serverBuildPath).href);
  app.all("*path", createRequestHandler({ build, mode: "production" }));
} else {
  // Dev: Vite in middleware mode owns client assets + HMR; the SSR handler pulls
  // the server build from Vite's module graph fresh on each request.
  const vite = await import("vite");
  const viteServer = await vite.createServer({
    server: { middlewareMode: true },
    appType: "custom",
  });
  app.use(viteServer.middlewares);
  app.all(
    "*path",
    createRequestHandler({
      build: () =>
        viteServer.ssrLoadModule("virtual:react-router/server-build") as any,
      mode: "development",
    }),
  );
}

app.listen(PORT, () => {
  console.log(`e2e-explorer server listening on http://localhost:${PORT}`);
  console.log(
    `Mode: ${isProd ? "production (SSR)" : "development (SSR + Vite)"}`,
  );
  console.log(`Cluecumber reports: ${CLUECUMBER_BASE_URL}`);
});
