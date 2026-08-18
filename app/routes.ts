import {
  type RouteConfig,
  index,
  layout,
  route,
} from "@react-router/dev/routes";

export default [
  layout("layout.tsx", [
    index("routes/index.tsx"),
    route("runs/:runId", "routes/runs.$runId.tsx"),
    route("runs/:runId/logs", "routes/runs.$runId.logs.tsx"),
    route("api/data-version", "routes/api.data-version.tsx"),
    route("scenarios", "routes/scenarios.tsx"),
    route("services", "routes/services.tsx"),
  ]),
] satisfies RouteConfig;
