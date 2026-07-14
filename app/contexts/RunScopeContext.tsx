import { createContext, useContext, useState, type ReactNode } from "react";

interface RunScopeValue {
  /** True = show nightly runs only (the default); false = all runs. This is a
   *  global view preference (not a per-page deep-link filter), so it lives in
   *  context rather than the URL: it's shared across pages and survives
   *  navigation. It resets to nightly on a full refresh, matching the app's
   *  other in-memory preferences. */
  nightlyOnly: boolean;
  setNightlyOnly: (on: boolean) => void;
}

const RunScopeContext = createContext<RunScopeValue | null>(null);

/** Holds the nightly/all-runs scope, shared by the date-range control (writer)
 *  and every page that lists runs (readers). Mounted in the layout above the
 *  route Outlet so it persists as the user moves between pages. */
export function RunScopeProvider({ children }: { children: ReactNode }) {
  const [nightlyOnly, setNightlyOnly] = useState(true);
  return (
    <RunScopeContext.Provider value={{ nightlyOnly, setNightlyOnly }}>
      {children}
    </RunScopeContext.Provider>
  );
}

export function useRunScope(): RunScopeValue {
  const ctx = useContext(RunScopeContext);
  if (!ctx) throw new Error("useRunScope must be used within RunScopeProvider");
  return ctx;
}
