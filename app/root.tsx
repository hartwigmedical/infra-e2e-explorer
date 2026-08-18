import { useEffect } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import type { Route } from "./+types/root";
import { Toaster } from "sonner";
import "./app.css";

// The SPA era cached slim Parquet per-browser in this IndexedDB database; the
// SSR version doesn't use IndexedDB at all (the cache is server-side now), so a
// returning user's browser would otherwise keep this (potentially tens of MB)
// orphaned forever. Delete it once per browser (see useLegacyCacheCleanup).
const LEGACY_CACHE_DB = "e2e-explorer-report-cache";
const LEGACY_CACHE_CLEARED_KEY = "e2e:legacyCacheCleared";

/** Best-effort, once-per-browser teardown of the orphaned SPA-era IndexedDB
 *  cache. Client-only (runs in an effect); a localStorage flag stops it from
 *  re-attempting on every load. */
function useLegacyCacheCleanup() {
  useEffect(() => {
    try {
      if (typeof indexedDB === "undefined") return;
      if (localStorage.getItem(LEGACY_CACHE_CLEARED_KEY) === "1") return;
      const req = indexedDB.deleteDatabase(LEGACY_CACHE_DB);
      // Mark done on terminal outcomes only. On "blocked" (another tab still
      // holds it open) leave the flag unset so a later load retries.
      const markDone = () => {
        try {
          localStorage.setItem(LEGACY_CACHE_CLEARED_KEY, "1");
        } catch {
          // localStorage unavailable — we'll just try again next load.
        }
      };
      req.onsuccess = markDone;
      req.onerror = markDone;
    } catch {
      // indexedDB/localStorage unavailable — nothing to clean up.
    }
  }, []);
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Empty inline icon so the browser doesn't request (and 404 on)
            /favicon.ico. Swap for a real icon later if desired. */}
        <link rel="icon" href="data:," />
        <Meta />
        <Links />
      </head>
      <body className="overflow-x-hidden">
        {children}
        <Toaster richColors position="top-center" />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  useLegacyCacheCleanup();
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
