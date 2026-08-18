/**
 * Bounded fan-out for the data layer.
 *
 * The store works over EVERY run in the bucket (thousands), and both the GCS
 * metadata lookups (sources.ts) and the cache freshness/extraction passes
 * (cache.ts) are per-run I/O. An unbounded `Promise.all` over that list means
 * thousands of concurrent requests / open files on every cold process, so all of
 * it goes through here instead.
 */

/** Map `items` through `worker`, at most `limit` in flight, results in order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function runNext(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runNext),
  );
  return results;
}
