import {
  createContext,
  useContext,
  useEffect,
  useRef,
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
  // Start from the SSR default (nightly-only) on BOTH server and the first
  // client render, then adopt the persisted value in an effect. Reading
  // localStorage during render would make the first client render diverge from
  // the server HTML → a hydration mismatch (React error #418). The stored value
  // is applied right after mount, re-filtering in place.
  const [nightlyOnly, setNightlyOnly] = useState(true);
  // Skip persisting until we've read the stored value, so the initial default
  // doesn't clobber a stored "all runs" before the effect below restores it.
  const hydratedRef = useRef(false);

  useEffect(() => {
    const stored = readStoredNightlyOnly();
    hydratedRef.current = true;
    if (stored !== true) setNightlyOnly(stored);
  }, []);

  useEffect(() => {
    if (!hydratedRef.current) return;
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
