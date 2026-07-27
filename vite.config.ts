import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    alias: {
      "~": path.resolve(__dirname, "./app"),
      "@": path.resolve(__dirname, "./"),
    },
  },
  // No dev proxy needed: Express is now the single dev entry (SSR), running Vite
  // in middleware mode and serving /api + /config.js directly. See server/index.ts.
  //
  // Pre-bundle the client deps up front so the middleware-mode optimizer does a
  // single pass with one stable hash. Without this, deps discovered late (sonner
  // via the root Toaster, lucide-react icons) were optimized in a second pass and
  // served with stale hashes → "504 (Outdated Optimize Dep)" on those chunks →
  // the client entry failed to load → SSR HTML rendered but never hydrated (dead
  // buttons). Keep this list in sync with the app's runtime node deps.
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-dom/client",
      "react-router",
      "sonner",
      "lucide-react",
      "date-fns",
      "clsx",
      "tailwind-merge",
      "class-variance-authority",
      "canvas-confetti",
    ],
  },
});
