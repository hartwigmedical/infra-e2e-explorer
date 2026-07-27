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
  optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
  worker: { format: "es" },
});
