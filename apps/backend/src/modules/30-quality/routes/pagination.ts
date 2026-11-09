// apps/backend/src/modules/30-quality/routes/pagination.ts — M30 (§4.1.2) list paging.
//
// The page envelope + in-memory keyset helper the bounded M30 LIST routes share. The cursor is the route
// kit's signed `(sort value, id)` codec (a tampered or foreign cursor is 422 INVALID_CURSOR); offset
// pagination is forbidden on PHI lists (§4.1.2; SD-052). The §4.1.2 PHI lists (R-50 incidents, R-70
// mortality, R-90 infection events) page in SQL instead (./phi-list-queries.ts).
import { decodeKeysetCursor, encodeCursor } from "@chartwarden/shared/route-kit";

/** A row the in-memory helper can page: its anchor timestamp (`created_at` or a partition key) + id. */
export interface CursorKeyset {
  readonly createdAt: string;
  readonly id: string;
}

/** The default + maximum page size for the M30 list routes (default 50, max 100 per §4.1.2). */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/** Clamp a requested page size into the [1, MAX] range, defaulting to {@link DEFAULT_PAGE_SIZE}. */
export function pageSizeOf(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, limit));
}

/** One page of `items` plus the opaque `nextCursor`/`hasMore` envelope every list route returns. */
export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/**
 * Keyset-paginate `rows` (already DESC-sorted by `(createdAt, id)`) into a {@link CursorPage}. Pure:
 * given the same rows + cursor + limit it returns the same page (RLS scopes upstream).
 */
export function paginate<T extends CursorKeyset>(
  organizationId: string,
  rows: readonly T[],
  cursor: string | undefined,
  limit: number | undefined,
): CursorPage<T> {
  const size = pageSizeOf(limit);
  // In-memory string compare, never cast: the anchors and ids of these lists are not all instants/uuids.
  const key = decodeKeysetCursor(organizationId, cursor, "text", { id: "text" });
  let start = 0;
  if (key) {
    start = rows.findIndex((r) => r.createdAt < key.a || (r.createdAt === key.a && r.id < key.id));
    if (start === -1) start = rows.length;
  }
  const slice = rows.slice(start, start + size);
  const hasMore = start + size < rows.length;
  const last = slice[slice.length - 1];
  return {
    items: slice,
    nextCursor:
      hasMore && last ? encodeCursor(organizationId, { a: last.createdAt, id: last.id }) : null,
    hasMore,
  };
}
