import { useMemo, useState } from "react";
import { Link } from "react-router";
import {
  ArrowRight,
  Boxes,
  ChevronRight,
  Minus,
  Plus,
  TriangleAlert,
} from "lucide-react";
import { useE2eData, useE2eQuery } from "~/contexts/E2eDataContext";
import { useRunScope } from "~/contexts/RunScopeContext";
import { cn } from "~/lib/utils";

/** One (current ⟕ previous) service row from the deployment-diff query. */
interface SvcRow {
  service: string;
  cur_spec: string | null;
  cur_version: string | null;
  cur_pv: string | null;
  prev_spec: string | null;
  prev_version: string | null;
  prev_pv: string | null;
  /** Booleans arrive from duckdb-wasm as JS booleans. */
  in_cur: boolean;
  in_prev: boolean;
  /** run_id of the run we diff against (max run_id < this run in the loaded
   *  window), or null when there's no earlier run loaded. Repeated per row. */
  prev_run_id: string | null;
  /** Per-run meta, repeated on every current row (null on removed-only rows). */
  n_scenarios: number | null;
  distinct_blocks: number | null;
}

type ChangeKind = "added" | "removed" | "changed" | "same";

/** Escape a value for safe interpolation into a single-quoted SQL string literal. */
function sqlLit(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The version label for a service: the parsed `version` (plus the pipeline
 *  version for launchers, which is the number people actually track), falling
 *  back to the raw spec when there's no `image:tag` version at all (e.g.
 *  `mailpit`, `mongodb4`). */
function versionLabel(
  version: string | null,
  spec: string | null,
  pipelineVersion: string | null,
): string {
  const base = version ?? spec ?? "—";
  return pipelineVersion ? `${base} · pipeline ${pipelineVersion}` : base;
}

function changeKind(row: SvcRow): ChangeKind {
  if (row.in_cur && !row.in_prev) return "added";
  if (!row.in_cur && row.in_prev) return "removed";
  // spec carries the full "image:tag [--pipeline_version X]", so comparing it
  // catches image, tag, AND pipeline-version changes in one shot.
  if (row.cur_spec !== row.prev_spec) return "changed";
  return "same";
}

/** The colored left-edge indicator + glyph for a change row. */
function ChangeGlyph({ kind }: { kind: ChangeKind }) {
  if (kind === "added")
    return (
      <Plus
        size={13}
        className="shrink-0 text-emerald-600 dark:text-emerald-400"
      />
    );
  if (kind === "removed")
    return (
      <Minus size={13} className="shrink-0 text-red-600 dark:text-red-400" />
    );
  return (
    <ArrowRight
      size={13}
      className="shrink-0 text-amber-600 dark:text-amber-400"
    />
  );
}

/**
 * The "what was deployed for this run" panel on the run-detail page: the service
 * image versions the run executed against (parsed from the "Running services"
 * log block - see buildServiceVersionsSelectSql), plus a diff against the
 * previous run so a failure can be lined up with a deployment.
 *
 * Renders nothing when there's no version data for this run (extraction failed,
 * or an era/report without the block). Gated by the caller on `detailsReady`.
 */
export default function ServiceVersions({ runId }: { runId: string }) {
  const { detailsReady } = useE2eData();
  // Diff against the previous run in the SAME scope as the Services timeline
  // (RunScopeContext) - so when nightly-only is on, this run's baseline is the
  // previous NIGHTLY, not an intervening manual re-run. Otherwise the two views
  // disagree: a nightly can read "no change" here (vs a same-day manual run that
  // already picked up the deploy) while the Services page shows it changed vs the
  // prior nightly.
  const { nightlyOnly } = useRunScope();
  const [showAll, setShowAll] = useState(false);

  const runIdLit = sqlLit(runId);
  const { rows, loading } = useE2eQuery<SvcRow>(
    detailsReady && runId
      ? `
      WITH cur AS (
        SELECT service, spec, version, pipeline_version, n_scenarios, distinct_blocks
        FROM service_versions WHERE run_id = ${runIdLit}
      ),
      prev_id AS (
        SELECT max(sv.run_id) AS pid
        FROM service_versions sv JOIN runs r USING (run_id)
        WHERE sv.run_id < ${runIdLit}${nightlyOnly ? " AND r.is_nightly" : ""}
      ),
      prev AS (
        SELECT sv.service, sv.spec, sv.version, sv.pipeline_version
        FROM service_versions sv, prev_id WHERE sv.run_id = prev_id.pid
      )
      SELECT
        coalesce(cur.service, prev.service) AS service,
        cur.spec AS cur_spec, cur.version AS cur_version, cur.pipeline_version AS cur_pv,
        prev.spec AS prev_spec, prev.version AS prev_version, prev.pipeline_version AS prev_pv,
        (cur.service IS NOT NULL) AS in_cur,
        (prev.service IS NOT NULL) AS in_prev,
        (SELECT pid FROM prev_id) AS prev_run_id,
        cur.n_scenarios AS n_scenarios, cur.distinct_blocks AS distinct_blocks
      FROM cur FULL OUTER JOIN prev ON cur.service = prev.service
      ORDER BY service`
      : null,
    [detailsReady, runId, nightlyOnly],
  );

  const model = useMemo(() => {
    const curRows = rows.filter((r) => r.in_cur);
    const prevCount = rows.filter((r) => r.in_prev).length;
    const prevRunId =
      rows.find((r) => r.prev_run_id != null)?.prev_run_id ?? null;
    // A baseline exists only when the previous run actually contributed version
    // data - otherwise (no earlier run in the window, or its extraction failed)
    // every service would spuriously read as "added", so we show a plain list.
    const hasBaseline = prevRunId != null && prevCount > 0;
    const distinctBlocks =
      curRows.find((r) => r.distinct_blocks != null)?.distinct_blocks ?? null;
    const nScenarios =
      curRows.find((r) => r.n_scenarios != null)?.n_scenarios ?? null;

    const withKind = rows.map((r) => ({ row: r, kind: changeKind(r) }));
    const changes = hasBaseline
      ? withKind.filter((x) => x.kind !== "same")
      : [];
    // Rank changes: changed first (most actionable), then added, then removed.
    const rank: Record<ChangeKind, number> = {
      changed: 0,
      added: 1,
      removed: 2,
      same: 3,
    };
    changes.sort(
      (a, b) =>
        rank[a.kind] - rank[b.kind] ||
        a.row.service.localeCompare(b.row.service),
    );

    return {
      curRows,
      curCount: curRows.length,
      prevRunId,
      hasBaseline,
      distinctBlocks,
      nScenarios,
      changes,
    };
  }, [rows]);

  // Nothing to show: no current-run version data (extraction failed, or a
  // report era without the block). Stay quiet rather than render an empty card.
  if (loading || model.curCount === 0) return null;

  const { curRows, curCount, prevRunId, hasBaseline, distinctBlocks, changes } =
    model;
  const inconsistent = (distinctBlocks ?? 1) > 1;

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-b bg-muted/30 px-4 py-2.5">
        <h2 className="inline-flex items-center gap-2 text-sm font-medium">
          <Boxes size={15} className="shrink-0 text-muted-foreground" />
          Services
          <span className="font-normal text-muted-foreground">
            ({curCount})
          </span>
        </h2>
        <div className="text-xs text-muted-foreground">
          {!hasBaseline ? (
            "No earlier run loaded to compare against"
          ) : changes.length === 0 ? (
            <span className="inline-flex items-center gap-1">
              No changes since
              <PrevRunLink prevRunId={prevRunId!} />
            </span>
          ) : (
            <span className="inline-flex items-center gap-1">
              <span className="font-medium text-foreground">
                {changes.length} changed
              </span>
              since
              <PrevRunLink prevRunId={prevRunId!} />
            </span>
          )}
        </div>
      </div>

      {inconsistent && (
        <div className="flex items-start gap-2 border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-xs text-amber-700 dark:text-amber-400">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span>
            Service versions varied across scenarios in this run; showing the
            most common set.
          </span>
        </div>
      )}

      {changes.length > 0 && (
        <ul className="divide-y divide-border/60">
          {changes.map(({ row, kind }) => (
            <li
              key={row.service}
              className="flex items-center gap-2.5 px-4 py-1.5 text-[13px]"
            >
              <ChangeGlyph kind={kind} />
              <span className="min-w-0 flex-1 truncate font-medium">
                {row.service}
              </span>
              <span className="shrink-0 font-mono text-xs">
                {kind === "added" ? (
                  <span className="text-emerald-700 dark:text-emerald-400">
                    {versionLabel(row.cur_version, row.cur_spec, row.cur_pv)}
                  </span>
                ) : kind === "removed" ? (
                  <span className="text-muted-foreground line-through">
                    {versionLabel(row.prev_version, row.prev_spec, row.prev_pv)}
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="text-muted-foreground line-through">
                      {versionLabel(
                        row.prev_version,
                        row.prev_spec,
                        row.prev_pv,
                      )}
                    </span>
                    <ArrowRight
                      size={11}
                      className="shrink-0 text-muted-foreground/70"
                    />
                    <span className="text-foreground">
                      {versionLabel(row.cur_version, row.cur_spec, row.cur_pv)}
                    </span>
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className={cn(changes.length > 0 && "border-t")}>
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
          className="flex w-full items-center gap-1.5 px-4 py-2 text-xs text-muted-foreground hover:bg-muted/40 hover:text-foreground"
        >
          <ChevronRight
            size={13}
            className={cn(
              "shrink-0 transition-transform",
              showAll && "rotate-90",
            )}
          />
          {showAll ? "Hide" : "Show"} all {curCount} services
        </button>
        {showAll && (
          <ul className="grid grid-cols-1 gap-x-6 gap-y-0.5 px-4 pt-1 pb-3 text-xs sm:grid-cols-2">
            {curRows.map((row) => (
              <li
                key={row.service}
                className="flex items-baseline justify-between gap-3 py-0.5"
              >
                <span className="min-w-0 truncate text-muted-foreground">
                  {row.service}
                </span>
                <span className="shrink-0 font-mono text-foreground">
                  {versionLabel(row.cur_version, row.cur_spec, row.cur_pv)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** The previous run's id as a monospace link to its detail page. */
function PrevRunLink({ prevRunId }: { prevRunId: string }) {
  return (
    <Link
      to={`/runs/${encodeURIComponent(prevRunId)}`}
      className="font-mono text-foreground underline decoration-dotted decoration-muted-foreground/40 underline-offset-2 hover:decoration-muted-foreground"
      title={`Compare against ${prevRunId}`}
    >
      {prevRunId}
    </Link>
  );
}
