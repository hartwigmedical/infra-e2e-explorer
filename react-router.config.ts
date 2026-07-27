import type { Config } from "@react-router/dev/config";

export default {
  // SSR experiment: render routes on the server so pages arrive as real HTML
  // (fast first paint, LLM-ingestible) and loaders can run server-side.
  // See docs/ssr-experiment.md.
  ssr: true,
} satisfies Config;
