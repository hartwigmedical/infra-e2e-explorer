import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildScenariosSelectSql,
  buildSlimSelectSql,
  buildTestIdsSelectSql,
} from "../app/lib/e2e-views.ts";
import { query, run } from "../server/data/engine.ts";

/**
 * One Scenario Outline example as Cucumber's legacy JSON formatter emits it.
 * Every example of an outline whose Examples blocks are unnamed carries the SAME
 * `id`, so `line` is the only thing distinguishing them - which is what
 * SLIM_ELEMENTS_REBUILD disambiguates on at extraction time.
 */
function scenario(line: number, testId: string) {
  return {
    id: "feature;outline;;2",
    name: "An outline example",
    line,
    type: "scenario",
    tags: [],
    start_timestamp: "2026-08-25T00:00:00Z",
    before: [],
    after: [
      {
        result: { status: "passed", duration: 1 },
        match: { location: "AfterHooks.attachLog" },
        embeddings: [
          {
            mime_type: "text/plain",
            name: `Log of test ${testId}`,
            data: Buffer.from(`log for line ${line}`).toString("base64"),
          },
        ],
      },
    ],
    steps: [
      {
        keyword: "Given ",
        name: "a precondition",
        line: 4,
        match: { location: "Steps.precondition", arguments: [] },
        result: { status: "passed", duration: 1, error_message: null },
      },
    ],
  };
}

/** Extract a one-feature report with two same-id examples into a v_features-shaped
 *  view, and hand the view name to `body`. */
async function withDuplicateIdReport(
  viewName: string,
  body: () => Promise<void>,
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "e2e-views-test-"));
  const report = path.join(dir, "cucumber.json");
  try {
    await writeFile(
      report,
      JSON.stringify([
        {
          uri: "classpath:features/SaasResearchDatabase.feature",
          name: "SaaS research database",
          keyword: "Feature",
          tags: [],
          elements: [scenario(83, "96027576"), scenario(88, "21976831")],
        },
      ]),
    );
    await run(
      `CREATE OR REPLACE VIEW ${viewName} AS ${buildSlimSelectSql(report, "duplicate-id-run")}`,
    );
    await body();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("duplicate Cucumber scenario ids remain one row per example", async () => {
  await withDuplicateIdReport("dup_scenarios_features", async () => {
    const rows = await query<{ scenario_id: string; test_id: string }>(`
      WITH scenarios AS (${buildScenariosSelectSql("dup_scenarios_features")}),
           test_ids AS (${buildTestIdsSelectSql("dup_scenarios_features")})
      SELECT scenarios.scenario_id, test_ids.test_id
      FROM scenarios
      LEFT JOIN test_ids USING (run_id, feature_uri, scenario_id)
      ORDER BY scenarios.ordinal
    `);

    assert.deepEqual(rows, [
      { scenario_id: "feature;outline;;2", test_id: "96027576" },
      { scenario_id: "feature;outline;;2;;line-88", test_id: "21976831" },
    ]);
  });
});

test("the stored element id is already unique, so raw readers key correctly", async () => {
  await withDuplicateIdReport("dup_logs_features", async () => {
    // The shape runs.$runId.logs.tsx uses: it reads `e.id`/`e.log` straight off
    // the cached Parquet with no disambiguation of its own. That is only safe
    // because the id was made unique at extraction time - if it regressed, both
    // examples would collide onto one key and the client's scenario_id -> log
    // Map would drop one of them.
    const logs = await query<{ scenario_id: string; log: string | null }>(
      `SELECT e.id AS scenario_id, e.log AS log
         FROM dup_logs_features f, UNNEST(f.elements) AS t(e)
        WHERE e."type" = 'scenario'
        ORDER BY e.line`,
    );

    assert.deepEqual(logs, [
      { scenario_id: "feature;outline;;2", log: "log for line 83" },
      { scenario_id: "feature;outline;;2;;line-88", log: "log for line 88" },
    ]);
    assert.equal(new Map(logs.map((r) => [r.scenario_id, r.log])).size, 2);
  });
});
