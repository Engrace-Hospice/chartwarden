// apps/backend/src/modules/22-documents/routes/pagination.ts — M22 (§4.1 / SD-052) keyset pagination over
// an org-scoped, `(createdAt DESC, id)`-sorted read window. The cursor is the route kit's HMAC-signed
// opaque cursor (a forged/foreign/garbled cursor is 422 INVALID_CURSOR); M22 keeps its camelCase
// `{ items, nextCursor, hasMore }` envelope, which the generated client already types.
import {
  type PageSizePolicy,
  clampLimit,
  decodeCursor,
  encodeCursor,
  isKeysetCursor,
} from "@chartwarden/shared/route-kit";

/** §4.1 page sizes for PHI list routes: default 50, max 200. */
export const M22_PAGE_SIZE: PageSizePolicy = { defaultSize: 50, maxSize: 200 };

/** One page of `items` plus the opaque `nextCursor`/`hasMore` envelope every M22 list route returns. */
export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** Keyset-paginate `rows` (already org-scoped + DESC-sorted by `(createdAt, id)`) into a {@link CursorPage}. */
export function paginate<T extends { readonly createdAt: string; readonly id: string }>(
  organizationId: string,
  rows: readonly T[],
  cursor: string | undefined,
  limit: number | undefined,
): CursorPage<T> {
  const size = clampLimit(limit, M22_PAGE_SIZE);
  const key = decodeCursor(organizationId, cursor, isKeysetCursor);
  // strict keyset: skip everything at-or-after the cursor row in DESC `(createdAt, id)` order.
  const found = key
    ? rows.findIndex((r) => r.createdAt < key.a || (r.createdAt === key.a && r.id < key.id))
    : 0;
  const start = found === -1 ? rows.length : found;
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
