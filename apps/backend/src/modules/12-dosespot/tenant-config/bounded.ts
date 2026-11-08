// apps/backend/src/modules/12-dosespot/tenant-config/bounded.ts — map with a concurrency limit, results in input order. The operator's roster list
// resolves one physician record per prescriber; unbounded that is one directory call per row at once.

export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("mapBounded: limit must be at least 1");
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
