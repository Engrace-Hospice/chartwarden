// apps/backend/src/modules/36-messaging/drafts/draft-after-send.ts - WP 2.5 + 3.3: what happens to the sender's own
// draft slot inside the send transaction. A plain send consumed the whole draft, so the slot goes. An SBAR send
// consumed only the SBAR form: the text the sender was typing alongside it stays (resealed without the `sbar` field),
// and the row goes only when nothing else is left. Same envelope and owner pinning as draft-service-db.ts (the filter
// names org and owner, and the draft table's RLS pins them again).
import { schema } from "@wardenx/db";
import type { MessageReferenceInput } from "@wardenx/messaging";
import { and, eq, isNull } from "drizzle-orm";
import type { MessageBodyCipher, Tx } from "../messaging-write-core";

const DRAFT = schema.messageDrafts;

export interface SentDraftSlot {
  readonly orgId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly parentMessageId?: string | null | undefined;
  /** True when the message just sent was an SBAR (`richBodySbar(body) !== null`). */
  readonly sentSbar: boolean;
}

export async function settleDraftAfterSend(
  tx: Tx,
  cipher: MessageBodyCipher,
  slot: SentDraftSlot,
): Promise<void> {
  const where = and(
    eq(DRAFT.organizationId, slot.orgId),
    eq(DRAFT.userId, slot.userId),
    eq(DRAFT.channelId, slot.channelId),
    slot.parentMessageId
      ? eq(DRAFT.parentMessageId, slot.parentMessageId)
      : isNull(DRAFT.parentMessageId),
  );
  if (slot.sentSbar) {
    const [row] = await tx.select().from(DRAFT).where(where).limit(1).for("update");
    if (!row) return;
    const sealed = JSON.parse(await cipher.open(slot.orgId, row.bodyCipher)) as {
      body: string;
      references: readonly MessageReferenceInput[];
    };
    if (sealed.body.trim() !== "") {
      // Rebuilt from body and references only, so the sbar field (and any future one) is dropped.
      const { cipher: bodyCipher } = await cipher.seal(
        slot.orgId,
        JSON.stringify({ body: sealed.body, references: sealed.references }),
      );
      await tx
        .update(DRAFT)
        .set({ bodyCipher, revision: row.revision + 1, updatedAt: new Date() })
        .where(and(eq(DRAFT.organizationId, slot.orgId), eq(DRAFT.id, row.id)));
      return;
    }
  }
  await tx.delete(DRAFT).where(where);
}
