/**
 * IndexedDB-backed cache of per-run "slim" report Parquet buffers, keyed by the
 * immutable run_id. Lets a repeat session (and every `loadMore`) skip fetching
 * and re-parsing reports it has already seen - see E2eDataContext's STAGE 2 for
 * the hit/miss flow and e2e-views.ts's SCHEMA_VERSION for staleness handling.
 *
 * Why IndexedDB and not OPFS / the Cache API: the app is deployed over plain
 * HTTP on an internal host (see deploy/cors.json - http://e2e-explorer.gateway.
 * pilot-1), which is NOT a secure context, so OPFS, the Cache API, Service
 * Workers, and navigator.storage are all unavailable there. IndexedDB has no
 * secure-context requirement and holds hundreds of MB of binary buffers, so
 * it's the one large-capacity client store that works in prod. A consequence:
 * we can't call navigator.storage.persist() to pin the data, so entries are
 * evictable under disk pressure - that's fine, a miss just re-extracts.
 *
 * What's cached: the compact, columnar Parquet of ONE run's slim feature
 * structure - the expensive-to-obtain, rarely-changing output of parsing the
 * multi-MB raw cucumber.json with its base64 embedding `data` stripped (see
 * SLIM_FEATURES_COLUMNS). NOT the fully-analysed scenarios/steps tables: the
 * analysis SQL is cheap and re-run each session over the cached slim data, so
 * changing status/background/test_id logic needs NO cache invalidation. Only a
 * change to the *set of raw fields extracted* bumps SCHEMA_VERSION and clears
 * the store (handled at open()).
 */

const DB_NAME = "e2e-explorer-report-cache";
const DB_VERSION = 1;
const REPORTS_STORE = "reports";
const META_STORE = "meta";
const SCHEMA_VERSION_KEY = "schemaVersion";

/** One cached run: its slim Parquet bytes plus the manifest facts we validate a
 *  hit against (a run folder is effectively immutable, but if its report were
 *  ever re-uploaded size_bytes/source would change and force a re-extract). */
export interface CachedSlimReport {
  run_id: string;
  size_bytes: number | null;
  source: string | null;
  bytes: Uint8Array;
  cachedAt: number;
}

export interface ReportCache {
  /** True when a real IndexedDB store is backing this cache (false = no-op). */
  readonly available: boolean;
  /** Fetch several runs at once (one readonly transaction). Missing runs are
   *  simply absent from the returned map. Never rejects - resolves empty on error. */
  getMany(runIds: string[]): Promise<Map<string, CachedSlimReport>>;
  /** Store/replace one run's slim Parquet. Never rejects (a failed write just
   *  means that run is re-extracted next time). */
  put(record: CachedSlimReport): Promise<void>;
}

/** Cache used whenever IndexedDB is missing or unusable: every lookup misses
 *  and every write is dropped, so callers transparently fall back to
 *  fetch-and-parse without any branching of their own. */
const NOOP_CACHE: ReportCache = {
  available: false,
  async getMany() {
    return new Map();
  },
  async put() {},
};

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txnDone(txn: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    txn.oncomplete = () => resolve();
    txn.onabort = txn.onerror = () => reject(txn.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(REPORTS_STORE)) {
        db.createObjectStore(REPORTS_STORE, { keyPath: "run_id" });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("IndexedDB open blocked"));
  });
}

/**
 * Open the report cache for a given SCHEMA_VERSION. If the store was written by
 * a different schema version (or has none yet), it's cleared first so we never
 * mix slim Parquet produced by different extraction schemas. Any failure -
 * IndexedDB absent (non-browser/SSR), disabled (private mode in some
 * browsers), or a blocked upgrade - resolves to a no-op cache so the app keeps
 * working, just without cross-session caching.
 */
export async function openReportCache(
  schemaVersion: string,
): Promise<ReportCache> {
  if (typeof indexedDB === "undefined") return NOOP_CACHE;

  let db: IDBDatabase;
  try {
    db = await openDb();
  } catch (err) {
    console.warn(
      "[report-cache] IndexedDB unavailable; running without report cache:",
      err,
    );
    return NOOP_CACHE;
  }

  try {
    const metaTxn = db.transaction(META_STORE, "readonly");
    const stored = (await promisifyRequest(
      metaTxn.objectStore(META_STORE).get(SCHEMA_VERSION_KEY),
    )) as { key: string; value: string } | undefined;

    if (stored?.value !== schemaVersion) {
      const wipeTxn = db.transaction([REPORTS_STORE, META_STORE], "readwrite");
      wipeTxn.objectStore(REPORTS_STORE).clear();
      wipeTxn
        .objectStore(META_STORE)
        .put({ key: SCHEMA_VERSION_KEY, value: schemaVersion });
      await txnDone(wipeTxn);
    }
  } catch (err) {
    // A version-check failure shouldn't take the whole cache down, but we also
    // can't trust the store's contents, so degrade to no-op for this session.
    console.warn(
      "[report-cache] version check failed; running without report cache:",
      err,
    );
    return NOOP_CACHE;
  }

  return {
    available: true,
    async getMany(runIds) {
      const found = new Map<string, CachedSlimReport>();
      if (runIds.length === 0) return found;
      try {
        const txn = db.transaction(REPORTS_STORE, "readonly");
        const store = txn.objectStore(REPORTS_STORE);
        const results = await Promise.all(
          runIds.map((id) =>
            promisifyRequest(store.get(id) as IDBRequest<CachedSlimReport>),
          ),
        );
        for (const rec of results) {
          if (rec) found.set(rec.run_id, rec);
        }
      } catch (err) {
        console.warn("[report-cache] read failed; treating as all-miss:", err);
      }
      return found;
    },
    async put(record) {
      try {
        const txn = db.transaction(REPORTS_STORE, "readwrite");
        txn.objectStore(REPORTS_STORE).put(record);
        await txnDone(txn);
      } catch (err) {
        console.warn(
          `[report-cache] write failed for ${record.run_id} (will re-extract next time):`,
          err,
        );
      }
    },
  };
}
