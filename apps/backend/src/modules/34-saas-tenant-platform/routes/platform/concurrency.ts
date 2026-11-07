// apps/backend/src/modules/34-saas-tenant-platform/routes/platform/concurrency.ts — M34 (§4.1 cursor pagination).
//
// The opaque keyset-cursor codec + page helper the platform-ops LIST routes paginate on (§4.1 SD-052):
// `GET /platform/tenants`, `GET /platform/tenant-invitations`, `GET /platform/onboarding-templates`.
// Mirrors the M22 routes/concurrency.ts precedent EXACTLY (cursor encodes `(createdAt DESC, id)`; offset
// pagination is forbidden); the codec is plain base64url JSON. It is NOT signed: a client can write any cursor, so a cursor is only a
// position in a list the caller may already read, and every consumer validates what it decodes (a cursor that goes into SQL as a
// timestamp and a uuid is checked with `decodeSqlCursor`). A malformed cursor is a 400 VALIDATION_FAILED (never page-from-start).
import { ChartWardenError } from "@chartwarden/types";

/** The keyset a cursor encodes — `(createdAt DESC, id)` (§4.1). Opaque to clients. */
export interface CursorKeyset {
  readonly createdAt: string;
  readonly id: string;
}

/** Encode a keyset into an opaque base64url cursor (unsigned: see the header; shape identical to the other modules' codecs). */
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

export const UUID_CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/**
 * An ISO-8601 UTC timestamp that round-trips: the shape (up to microseconds, `Z`), and a calendar date and clock time that exist, so
 * `2026-02-31T00:00:00Z` and `…T25:00:00Z` are refused instead of being normalised or reaching the database's cast as an error.
 */
export function isStrictIsoTimestamp(value: string): boolean {
  if (!CURSOR_TIMESTAMP.test(value)) return false;
  // Postgres has no year 0000 (its calendar goes 1 BC, 1 AD), though JavaScript parses it: refuse it here, not in the cast.
  if (Number(value.slice(0, 4)) < 1) return false;
  const seconds = value.slice(0, 19);
  const parsed = Date.parse(`${seconds}Z`);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString().slice(0, 19) === seconds;
}

/**
 * Decode a cursor whose keyset goes into SQL as a `timestamptz` and a `uuid` (a list that pages in SQL): both are checked here, so a
 * value that is neither is a clean 400, never a cast error from the database (a 500).
 */
export function decodeSqlCursor(cursor: string): CursorKeyset {
  const keyset = decodeCursor(cursor);
  if (!isStrictIsoTimestamp(keyset.createdAt) || !UUID_CURSOR_ID.test(keyset.id)) {
    throw new ChartWardenError("VALIDATION_FAILED", "the cursor is malformed", 400);
  }
  return keyset;
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
