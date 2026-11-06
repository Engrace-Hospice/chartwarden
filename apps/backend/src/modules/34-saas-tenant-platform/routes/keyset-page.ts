// apps/backend/src/modules/34-saas-tenant-platform/routes/keyset-page.ts — M34 (§4.1 / SD-052) list paging.
//
// Every M34 list pages by an opaque `(createdAt DESC, id)` keyset cursor signed by the route kit. Tenant
// lists sign with the caller's org id; the platform-ops lists span tenants and sign with
// {@link PLATFORM_CURSOR_SCOPE} (never a uuid, so a tenant cursor never verifies on a platform list or back).
import { decodeCursor, encodeCursor, isKeysetCursor } from "@chartwarden/shared/route-kit";

/** The cursor-signing scope of the cross-tenant platform-ops lists. */
export const PLATFORM_CURSOR_SCOPE = "platform";

/** The default + maximum page size (§4.1: default 50, max 200). */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** The keyset a row is paged on. */
export interface CursorKeyset {
  readonly createdAt: string;
  readonly id: string;
}

/** One page of `items` plus the opaque `nextCursor`/`hasMore` envelope every list route returns. */
export interface CursorPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

/** Clamp a requested page size into `[1, MAX]`, defaulting to {@link DEFAULT_PAGE_SIZE}. */
export function pageSizeOf(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_PAGE_SIZE, limit));
}

/** Sign a `(createdAt, id)` keyset for `scope`. */
export function encodeKeyset(scope: string, keyset: CursorKeyset): string {
  return encodeCursor(scope, { a: keyset.createdAt, id: keyset.id });
}

/** Verify + decode a cursor for `scope`; absent → null, bad → 422 INVALID_CURSOR. */
export function decodeKeyset(scope: string, cursor: string | undefined): CursorKeyset | null {
  const key = decodeCursor(scope, cursor, isKeysetCursor);
  return key ? { createdAt: key.a, id: key.id } : null;
}

/** Keyset-paginate `rows` (already DESC-sorted by `(createdAt, id)`) into a {@link CursorPage}. */
export function paginate<T extends CursorKeyset>(
  scope: string,
  rows: readonly T[],
  cursor: string | undefined,
  limit: number | undefined,
): CursorPage<T> {
  const size = pageSizeOf(limit);
  const key = decodeKeyset(scope, cursor);
  let start = 0;
  if (key) {
    start = rows.findIndex(
      (r) => r.createdAt < key.createdAt || (r.createdAt === key.createdAt && r.id < key.id),
    );
    if (start === -1) start = rows.length;
  }
  const slice = rows.slice(start, start + size);
  const hasMore = start + size < rows.length;
  const last = slice[slice.length - 1];
  return {
    items: slice,
    nextCursor: hasMore && last ? encodeKeyset(scope, last) : null,
    hasMore,
  };
}
