import { createContext, useContext, type ReactNode } from "react";
import { useDuckDB } from "~/hooks/useDuckDB";
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";

interface DuckDBContextValue {
  db: AsyncDuckDB | null;
  loading: boolean;
  error: Error | null;
}
const DuckDBContext = createContext<DuckDBContextValue | null>(null);

export function DuckDBProvider({ children }: { children: ReactNode }) {
  const value = useDuckDB();
  return <DuckDBContext.Provider value={value}>{children}</DuckDBContext.Provider>;
}

export function useDuckDBContext() {
  const ctx = useContext(DuckDBContext);
  if (!ctx) throw new Error("useDuckDBContext must be used within DuckDBProvider");
  return ctx;
}
