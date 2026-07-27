import { Link, Outlet, useLocation } from "react-router";
import type { Route } from "./+types/layout";
import { RunScopeProvider } from "~/contexts/RunScopeContext";
import DateRangeControl from "~/components/DateRangeControl";
import { cn } from "~/lib/utils";
import { ensureData, query } from "~/lib/data.server";

/**
 * Shell loader: the server holds the full dataset, so this just reports the
 * loaded-run range + daily density + total count for the header. Runs for every
 * route, so the header always has data without a client round-trip. The
 * nightly/all-runs scope stays a client view preference (see RunScopeContext).
 */
export async function loader() {
  const state = await ensureData();

  const [range] = await query<{ oldest: string | null; newest: string | null }>(
    "SELECT min(run_id) AS oldest, max(run_id) AS newest FROM runs",
  );
  const daily = await query<{ day: string; n: number }>(
    "SELECT substr(run_id,1,10) AS day, count(*) AS n FROM runs GROUP BY 1 ORDER BY 1",
  );

  return {
    runCount: state.runCount,
    range: range ?? { oldest: null, newest: null },
    daily,
  };
}

export type ShellData = Awaited<ReturnType<typeof loader>>;

function NavLinks() {
  const { pathname } = useLocation();
  // "Recent Runs" stays selected on a run's detail page (a drill-down from it);
  // "Scenarios" covers the matrix and the scenario detail view.
  const items = [
    {
      to: "/",
      label: "Recent Runs",
      active: pathname === "/" || pathname.startsWith("/runs"),
    },
    {
      to: "/scenarios",
      label: "Scenarios",
      active: pathname.startsWith("/scenarios"),
    },
    {
      to: "/services",
      label: "Services",
      active: pathname.startsWith("/services"),
    },
  ];
  return (
    <nav className="flex items-center gap-1 text-sm">
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          aria-current={item.active ? "page" : undefined}
          className={cn(
            "rounded-md px-2.5 py-1 transition-colors",
            item.active
              ? "bg-muted font-medium text-foreground"
              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

export default function Layout() {
  // All data now comes from server loaders. The only client context left is the
  // nightly/all-runs view preference (a client-side filter over loader data).
  return (
    <RunScopeProvider>
      <div className="min-h-screen bg-background text-foreground">
        <header className="flex h-(--header-height) items-center justify-between border-b px-4">
          <div className="flex items-center gap-6">
            <span className="font-semibold">E2E Explorer</span>
            <NavLinks />
          </div>
          <div className="flex items-center gap-4">
            <DateRangeControl />
          </div>
        </header>
        <main className="p-4">
          <Outlet />
        </main>
      </div>
    </RunScopeProvider>
  );
}
