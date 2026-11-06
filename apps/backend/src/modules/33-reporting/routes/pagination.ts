// apps/backend/src/modules/33-reporting/routes/pagination.ts — M33 (§4.1 cursor pagination).
//
// The in-memory keyset page helper the M33 LIST routes paginate on (dashboards / bases / metrics / MV
// registry / drilldown audit / definitions / views / schedules). The cursor encodes `(createdAt DESC, id)`
// through the route kit's org-bound signed codec; offset pagination is forbidden. A malformed, tampered or
// other-org cursor is 422 INVALID_CURSOR (never page-from-start).
import { decodeCursor, encodeCursor, isKeysetCursor } from "@chartwarden/shared/route-kit";

/** The default + maximum page size for the M33 list routes (default 50, max 200). */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

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
 * Keyset-paginate `rows` (already DESC-sorted by `(createdAt, id)`) into a {@link CursorPage} for
 * `organizationId`. Pure: given the same rows + cursor + limit it returns the same page (RLS scopes upstream).
 */
export function paginate<T extends { readonly createdAt: string; readonly id: string }>(
  organizationId: string,
  rows: readonly T[],
  cursor: string | undefined,
  limit: number | undefined,
): CursorPage<T> {
  const size = pageSizeOf(limit);
  const key = decodeCursor(organizationId, cursor, isKeysetCursor);
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
