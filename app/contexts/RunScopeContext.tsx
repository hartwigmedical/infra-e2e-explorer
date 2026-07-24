import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

interface RunScopeValue {
  /** True = show nightly runs only (the default); false = all runs. This is a
   *  global view preference (not a per-page deep-link filter), so it lives in
   *  context rather than the URL: it's shared across pages and survives
   *  navigation. It's also persisted to localStorage, so it survives a full
   *  refresh too (see NIGHTLY_ONLY_STORAGE_KEY). */
  nightlyOnly: boolean;
  setNightlyOnly: (on: boolean) => void;
}

const RunScopeContext = createContext<RunScopeValue | null>(null);

/** localStorage key for the nightly/all-runs scope, so the selection survives a
 *  refresh. localStorage works on the plain-HTTP prod host (unlike OPFS/
 *  navigator.storage), and a stale value is a harmless view preference. */
const NIGHTLY_ONLY_STORAGE_KEY = "e2e:nightlyOnly";

/** Persisted scope; defaults to nightly-only when absent/unavailable. */
function readStoredNightlyOnly(): boolean {
  try {
    const raw = localStorage.getItem(NIGHTLY_ONLY_STORAGE_KEY);
    return raw == null ? true : raw === "1";
  } catch {
    return true;
  }
}

/** Holds the nightly/all-runs scope, shared by the date-range control (writer)
 *  and every page that lists runs (readers). Mounted in the layout above the
 *  route Outlet so it persists as the user moves between pages, and to
 *  localStorage so it also survives a refresh. */
export function RunScopeProvider({ children }: { children: ReactNode }) {
  const [nightlyOnly, setNightlyOnly] = useState(readStoredNightlyOnly);

  useEffect(() => {
    try {
      localStorage.setItem(NIGHTLY_ONLY_STORAGE_KEY, nightlyOnly ? "1" : "0");
    } catch {
      // localStorage unavailable/full - the scope just won't persist.
    }
  }, [nightlyOnly]);

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
