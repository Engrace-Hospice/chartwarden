// ADR-0058 decision 9 - the global-search cursor: a keyset on (created_at, message_id) of the last EXAMINED candidate plus a
// `page` ordinal that bounds the cursor chain (MAX_PAGES_PER_QUERY). It never encodes a tag, a token, a query hash or any
// value derived from the query: the client re-sends `q` and the server re-derives the tags on every page.
import { MAX_PAGES_PER_QUERY } from "./params";

export interface SearchCursor {
  readonly createdAt: string;
  readonly messageId: string;
  /** Zero-based ordinal of the page this cursor continues from; at most MAX_PAGES_PER_QUERY. */
  readonly page: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeSearchCursor(cursor: SearchCursor): string {
  return encodeURIComponent(JSON.stringify([cursor.createdAt, cursor.messageId, cursor.page]));
}

/** Strict decode; any malformed, tampered or out-of-range value is `null` (the caller answers 422, never guesses). */
export function decodeSearchCursor(raw: string): SearchCursor | null {
  try {
    const value: unknown = JSON.parse(decodeURIComponent(raw));
    if (!Array.isArray(value) || value.length !== 3) return null;
    const [createdAt, messageId, page] = value as [unknown, unknown, unknown];
    if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) return null;
    if (typeof messageId !== "string" || !UUID.test(messageId)) return null;
    if (!Number.isInteger(page) || (page as number) < 0 || (page as number) > MAX_PAGES_PER_QUERY) {
      return null;
    }
    return { createdAt, messageId, page: page as number };
  } catch {
    return null;
  }
}
