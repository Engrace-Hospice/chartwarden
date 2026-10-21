// apps/backend/src/modules/36-messaging/message-search-tokens.ts - WP 2.7b chunk C1 (ADR-0058, Proposed).
// The explicit removal helper for the global search index: a future redaction request path (ADR-0055 item 7) calls it in
// the SAME transaction that records the request. Edit and delete need no call: the `trg_message_search_token_purge`
// trigger of migration 1091 already removes a message's tokens when its status becomes 'deleted' or `body_sha256` changes.
// It never consults the tenant flag (a message hidden while search is OFF must not be re-indexed later) and returns only a
// count: it never reads, returns or logs a tag.
import { schema } from "@chartwarden/db";
import { and, eq } from "drizzle-orm";
import type { Tx } from "./messaging-write-core";

const TOKENS = schema.messageSearchTokens;

/** Delete every token row of one message (all key versions). Idempotent; returns the number of rows removed. */
export async function deleteSearchTokens(
  tx: Tx,
  organizationId: string,
  messageId: string,
): Promise<number> {
  const removed = await tx
    .delete(TOKENS)
    .where(and(eq(TOKENS.organizationId, organizationId), eq(TOKENS.messageId, messageId)))
    .returning({ messageId: TOKENS.messageId });
  return removed.length;
}
