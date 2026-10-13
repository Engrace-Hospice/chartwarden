// ADR-0058 decision 9 - the global-search cursor: a keyset on (created_at, message_id) of the last EXAMINED candidate plus a
// `page` ordinal that bounds the cursor chain (MAX_PAGES_PER_QUERY). It never encodes a tag, a token, a query hash or any
// value derived from the query: the client re-sends `q` and the server re-derives the tags on every page.
import { MAX_PAGES_PER_QUERY } from "./params";

export interface SearchCursor {
  readonly createdAt: string;
  readonly messageId: string;
  /** Zero-based ordinal of the page this cursor asks for: 0..MAX_PAGES_PER_QUERY - 1 (a chain is at most 5 pages). */
  readonly page: number;
}

/** A real cursor is about 80 characters; refuse anything larger before decoding or parsing it. */
const MAX_RAW_LENGTH = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Exactly the form `Date#toISOString` emits, so a lenient date string never reaches a SQL comparison. */
function isStrictIso(value: string): boolean {
  const parsed = new Date(value);
  return /^\d{4}-/.test(value) && !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export function encodeSearchCursor(cursor: SearchCursor): string {
  return encodeURIComponent(JSON.stringify([cursor.createdAt, cursor.messageId, cursor.page]));
}

/** Strict decode; any malformed, tampered or out-of-range value is `null` (the caller answers 422, never guesses). */
export function decodeSearchCursor(raw: string): SearchCursor | null {
  if (raw.length === 0 || raw.length > MAX_RAW_LENGTH) return null;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(raw));
    if (!Array.isArray(value) || value.length !== 3) return null;
    const [createdAt, messageId, page] = value as [unknown, unknown, unknown];
    if (typeof createdAt !== "string" || !isStrictIso(createdAt)) return null;
    if (typeof messageId !== "string" || !UUID.test(messageId)) return null;
    if (
      !Number.isInteger(page) ||
      (page as number) < 0 ||
      (page as number) >= MAX_PAGES_PER_QUERY
    ) {
      return null;
    }
    return { createdAt, messageId, page: page as number };
  } catch {
    return null;
  }
}
