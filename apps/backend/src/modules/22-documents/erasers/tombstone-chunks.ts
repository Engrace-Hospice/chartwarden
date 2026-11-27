// CW-DS-01 — how the document eraser slices its tombstone INSERT. One INSERT binds 5 values per row (organization, bucket, object key,
// document, version) and Postgres allows 65,535 bound values per statement, so one statement fails past 13,107 versions: an erase of
// that many for one patient could never record its tombstones, and the erase (which records them BEFORE destroying anything) never
// started. The slices are inserted one statement each inside the eraser's single transaction.

/** Rows per tombstone INSERT: 5 bound values each, so 1,000 rows (5,000 values) stay far below Postgres's 65,535 limit. */
export const TOMBSTONE_INSERT_CHUNK = 1000;

/** `items` in consecutive slices of at most `size`; an empty list gives no slice (so no empty INSERT). */
export function inChunks<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1)
    throw new Error(`inChunks needs a whole size >= 1 (got ${size})`);
  const slices: T[][] = [];
  for (let at = 0; at < items.length; at += size) slices.push(items.slice(at, at + size));
  return slices;
}
