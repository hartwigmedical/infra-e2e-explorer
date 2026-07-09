import { useEffect, useState } from "react";
import * as duckdb from "@duckdb/duckdb-wasm";

let dbInstance: duckdb.AsyncDuckDB | null = null;
let dbPromise: Promise<duckdb.AsyncDuckDB> | null = null;

async function initDuckDB(): Promise<duckdb.AsyncDuckDB> {
  if (dbInstance) {
    return dbInstance;
  }

  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = (async () => {
    const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES);

    const worker_url = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], {
        type: "text/javascript",
      })
    );

    const worker = new Worker(worker_url);
    const logger = new duckdb.ConsoleLogger();
    const db = new duckdb.AsyncDuckDB(logger, worker);

    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    await db.open({
      query: {
        castBigIntToDouble: true,
        castDecimalToDouble: true,
      },
    });
    URL.revokeObjectURL(worker_url);

    // Load httpfs extension, needed to support setting the Authorization header
    const conn = await db.connect();
    await conn.query(`SET builtin_httpfs = false; LOAD httpfs;`);
    await conn.close();

    dbInstance = db;

    // Expose to dev console: await duckquery("SELECT * FROM ...")
    (window as any).__duckdb = db;
    (window as any).duckquery = async (sql: string) => {
      const conn = await db.connect();
      try {
        const result = await conn.query(sql);
        const rows = result
          .toArray()
          .map((row: any) => Object.fromEntries(Object.entries(row.toJSON())));
        console.table(rows);
        return rows;
      } finally {
        await conn.close();
      }
    };

    return db;
  })();

  return dbPromise;
}

export function useDuckDB() {
  const [db, setDb] = useState<duckdb.AsyncDuckDB | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    initDuckDB()
      .then((database) => {
        setDb(database);
        setLoading(false);
      })
      .catch((err) => {
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
  }, []);

  return { db, loading, error };
}
