import { Link, Outlet, useLocation } from "react-router";
import { DuckDBProvider } from "~/contexts/DuckDBContext";
import { E2eDataProvider, useE2eData } from "~/contexts/E2eDataContext";
import { RunScopeProvider } from "~/contexts/RunScopeContext";
import Spinner from "~/components/Spinner";
import DateRangeControl from "~/components/DateRangeControl";
import { cn } from "~/lib/utils";

function GlobalStatus() {
  const { status, runCount } = useE2eData();

  if (status === "ready") return null;

  const label =
    status === "error"
      ? "Failed to load e2e data"
      : status === "runs-ready"
        ? "Loading scenario details…"
        : `Loading${runCount ? ` ${runCount} runs` : ""}…`;

  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {status !== "error" && <Spinner size={13} />}
      {label}
    </span>
  );
}

function NavLinks() {
  const { pathname } = useLocation();
  // "Recent Runs" stays selected on a run's detail page (a drill-down from it);
  // "Scenarios" covers the matrix and the scenario detail view.
  const items = [
    { to: "/", label: "Recent Runs", active: pathname === "/" || pathname.startsWith("/runs") },
    { to: "/scenarios", label: "Scenarios", active: pathname.startsWith("/scenarios") },
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
              : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
          )}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

export default function Layout() {
  return (
    <DuckDBProvider>
      <E2eDataProvider>
        <RunScopeProvider>
        <div className="min-h-screen bg-background text-foreground">
          <header className="flex h-(--header-height) items-center justify-between border-b px-4">
            <div className="flex items-center gap-6">
              <span className="font-semibold">E2E Explorer</span>
              <NavLinks />
            </div>
            <div className="flex items-center gap-4">
              <GlobalStatus />
              <DateRangeControl />
            </div>
          </header>
          <main className="p-4">
            <Outlet />
          </main>
        </div>
        </RunScopeProvider>
      </E2eDataProvider>
    </DuckDBProvider>
  );
}
