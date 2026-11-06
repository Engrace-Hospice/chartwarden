// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/concurrency.ts — M34 (§4.1 cursor pagination).
//
// The opaque keyset-cursor codec + page helper the platform-ops LIST routes paginate on (§4.1 SD-052):
// `GET /platform/tenants`, `GET /platform/tenant-invitations`, `GET /platform/onboarding-templates`.
// Mirrors the M22 routes/concurrency.ts precedent EXACTLY (cursor encodes `(createdAt DESC, id)`; offset
// pagination is forbidden); the codec shape is base64url JSON in the slice + HMAC-signed in prod — the
// route surface is stable either way. A malformed cursor is a 400 VALIDATION_FAILED (never page-from-start).
import { ChartWardenError } from "@chartwarden/types";

/** The keyset a cursor encodes — `(createdAt DESC, id)` (§4.1). Opaque to clients. */
export interface CursorKeyset {
  readonly createdAt: string;
  readonly id: string;
}

/** Encode a keyset into an opaque base64url cursor (HMAC-signed in prod; shape identical). */
export function encodeCursor(keyset: CursorKeyset): string {
  return Buffer.from(JSON.stringify(keyset), "utf8").toString("base64url");
}

/** Decode an opaque cursor → keyset, or throw 400 VALIDATION_FAILED on a malformed/tampered value. */
export function decodeCursor(cursor: string): CursorKeyset {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Partial<CursorKeyset>;
    if (typeof parsed.createdAt !== "string" || typeof parsed.id !== "string") {
      throw new Error("missing keyset fields");
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new ChartWardenError("VALIDATION_FAILED", "the cursor is malformed", 400);
  }
}

/** The default + maximum page size for the platform list routes (§4.1: default 50, max 200). */
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
 * Where the page after `key` starts. The cursor names the LAST ROW THE CLIENT SAW, so the continuation is the row after it in the order
 * the rows arrived in: not a re-comparison of timestamps. A row's `createdAt` here is a JS Date's ISO string (milliseconds) while the
 * database ordered the rows at microseconds, so two rows of one millisecond can sit in an order the `(createdAt, id)` comparison
 * disagrees with, and comparing them repeated or skipped a row at the page boundary. A row that is gone since (deleted, or its key
 * changed) falls back to the keyset comparison, which is all every cursor issued before this ever did.
 */
function pageStartAfter<T extends CursorKeyset>(rows: readonly T[], key: CursorKeyset): number {
  const seen = rows.findIndex((r) => r.id === key.id);
  if (seen !== -1) return seen + 1;
  const next = rows.findIndex(
    (r) => r.createdAt < key.createdAt || (r.createdAt === key.createdAt && r.id < key.id),
  );
  return next === -1 ? rows.length : next;
}

/**
 * Keyset-paginate `rows` (already in the order they are served, newest first by `(createdAt, id)`) into a
 * {@link CursorPage}; the cursor continues AFTER the last row served (see {@link pageStartAfter}). Pure: given the same
 * rows + cursor + limit it returns the same page (RLS / platform-context scopes upstream).
 */
export function paginate<T extends CursorKeyset>(
  rows: readonly T[],
  cursor: string | undefined,
  limit: number | undefined,
): CursorPage<T> {
  const size = pageSizeOf(limit);
  let start = 0;
  if (cursor) {
    const key = decodeCursor(cursor);
    start = pageStartAfter(rows, key);
  }
  const slice = rows.slice(start, start + size);
  const hasMore = start + size < rows.length;
  const last = slice[slice.length - 1];
  return {
    items: slice,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null,
    hasMore,
  };
}
