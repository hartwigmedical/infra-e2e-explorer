import { Link, Outlet } from "react-router";
import { DuckDBProvider } from "~/contexts/DuckDBContext";
import { E2eDataProvider, useE2eData } from "~/contexts/E2eDataContext";
import Spinner from "~/components/Spinner";

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

export default function Layout() {
  return (
    <DuckDBProvider>
      <E2eDataProvider>
        <div className="min-h-screen bg-background text-foreground">
          <header className="flex h-(--header-height) items-center justify-between border-b px-4">
            <div className="flex items-center gap-6">
              <span className="font-semibold">E2E Explorer</span>
              <nav className="flex items-center gap-4 text-sm text-muted-foreground">
                <Link to="/" className="hover:text-foreground">
                  Recent Runs
                </Link>
                <Link to="/scenarios" className="hover:text-foreground">
                  Scenarios
                </Link>
              </nav>
            </div>
            <GlobalStatus />
          </header>
          <main className="p-4">
            <Outlet />
          </main>
        </div>
      </E2eDataProvider>
    </DuckDBProvider>
  );
}
