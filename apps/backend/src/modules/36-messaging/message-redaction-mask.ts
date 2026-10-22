// apps/backend/src/modules/36-messaging/message-redaction-mask.ts - WP 5.6 (ADR-0055 item 7; migration 1156): where a body is read, an APPROVED
// redaction masks it. A requested-but-not-approved redaction masks nothing (it only takes the message out of search). The mask is applied at
// the access layer: the cipher and hash stay, so a legal hold and the integrity job are unaffected.
import { schema } from "@chartwarden/db";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Tx } from "./messaging-write-core";

const RED = schema.messageRedactions;

/** What a reader sees in place of a redacted body: nothing, and when it was redacted (never the reason or the people). */
export const REDACTED_BODY = "";

/**
 * `messageId -> approved_at (ISO)` for the approved redactions among `messageIds`, in one org-filtered query (the unique
 * (organization_id, message_id) index serves it). Absent id = not redacted.
 */
export async function loadApprovedRedactions(
  tx: Tx,
  orgId: string,
  messageIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (messageIds.length === 0) return new Map();
  const rows = await tx
    .select({ messageId: RED.messageId, approvedAt: RED.approvedAt })
    .from(RED)
    .where(
      and(
        eq(RED.organizationId, orgId),
        inArray(RED.messageId, [...messageIds]),
        isNotNull(RED.approvedAt),
      ),
    );
  const out = new Map<string, string>();
  for (const row of rows) if (row.approvedAt) out.set(row.messageId, row.approvedAt.toISOString());
  return out;
}

/** True when an APPROVED redaction masks this message (the single-message form, for write paths that must refuse). */
export async function isMessageRedacted(
  tx: Tx,
  orgId: string,
  messageId: string,
): Promise<boolean> {
  return (await loadApprovedRedactions(tx, orgId, [messageId])).has(messageId);
}

/** True when ANY redaction (requested or approved) exists for the message: it can no longer be edited (a rewrite would dodge the review). */
export async function hasRedactionMark(tx: Tx, orgId: string, messageId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: RED.id })
    .from(RED)
    .where(and(eq(RED.organizationId, orgId), eq(RED.messageId, messageId)))
    .limit(1);
  return rows.length > 0;
}
