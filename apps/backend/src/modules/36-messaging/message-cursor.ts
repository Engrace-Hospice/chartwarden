// apps/backend/src/modules/36-messaging/message-cursor.ts - the opaque (created_at, id) keyset cursor shared by the
// channel history, the thread read and the WP 2.7a search.
import { ChartWardenError } from "@chartwarden/types";

/** Keyset cursor over (created_at, id) — opaque, never an offset (§4.12). `createdAtMicros` is the column read as
 * text (`created_at::text`): a JS Date keeps milliseconds only, and a cursor rounded down to the millisecond re-serves
 * the row it points at (duplicate on every page boundary) and can skip a neighbour. */
export function encodeCursor(createdAtMicros: string, id: string): string {
  return Buffer.from(`${createdAtMicros}|${id}`, "utf8").toString("base64url");
}
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:?\d{2})?$/;
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * A cursor is `created_at::text|uuid` as this service issued it. Anything else is the caller's mistake: a 400, never
 * a database cast error (500) and never a silent first page.
 */
export function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const parts = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const [createdAt, id] = parts;
  if (
    parts.length !== 2 ||
    !createdAt ||
    !id ||
    !CURSOR_TIME.test(createdAt) ||
    !CURSOR_ID.test(id)
  ) {
    throw new ChartWardenError("INVALID_CURSOR", "the cursor is not valid", 400);
  }
  return { createdAt, id };
}
