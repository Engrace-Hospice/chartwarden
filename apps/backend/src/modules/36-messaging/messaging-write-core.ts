// apps/backend/src/modules/36-messaging — the M36 WRITE core (FB-T05). The DB-backed primitives the
// MessagingRouteService write surface and the MessagingProvider seam share: per-tenant DEK body
// encryption (§3.4 / M36-F03) and the message-send → read-receipt fan-out + read-pointer flip.
//
// Both callers run these inside their own `withOrgContext` (RLS on `app.org_id` + the M4 write-audit
// trigger are the backstop); these helpers take the open `tx` so they compose into either factory's
// transaction. Message bodies are envelope-encrypted under the tenant DEK at write time — the seam
// boundary is plaintext by contract (§3.4) and the ciphertext never leaves this layer except as the
// `message.body_cipher` bytea.
import { type DbClient, schema } from "@wardenx/db";
import {
  deriveOrgDek,
  loadMessagingKek,
  messageBodySha256,
  openMessageBody,
  sealMessageBody,
} from "@wardenx/messaging";
import type { MessageBodyKind } from "@wardenx/messaging";
import { NotFoundError } from "@wardenx/types";
import { and, asc, eq, inArray, isNull, lte } from "drizzle-orm";

const CH = schema.channels;
const CM = schema.channelMembers;
const MSG = schema.messages;
const MR = schema.messageReceipts;

/** A Drizzle transaction handle (the structural type the DbClient hands its `transaction` callback). */
export type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/**
 * Per-tenant message body cipher (FB-T05). Loads the master KEK lazily (the first write) so a
 * read-only deployment without MESSAGING_ENCRYPTION_KEY still boots and serves reads; a write then
 * fails CLOSED with a clear error rather than storing plaintext. The org→DEK derivation is memoized
 * per process (deterministic HKDF, so the cache is just a CPU saver).
 */
export interface MessageBodyCipher {
  /** Seal a plaintext body under the tenant DEK + compute the pre-encryption integrity digest. */
  seal(orgId: string, plaintext: string): { cipher: Buffer; sha256: string };
  /** Decrypt a `body_cipher` bytea under the tenant DEK (entitled-reader path only). */
  open(orgId: string, cipher: Buffer): string;
}

/** Build the lazy, per-process {@link MessageBodyCipher}. `kek` is injectable for tests. */
export function createMessageBodyCipher(opts: { kek?: Buffer } = {}): MessageBodyCipher {
  let kek: Buffer | undefined = opts.kek;
  const getKek = (): Buffer => (kek ??= loadMessagingKek());
  const dekCache = new Map<string, Buffer>();
  const dekFor = (orgId: string): Buffer => {
    let dek = dekCache.get(orgId);
    if (!dek) {
      dek = deriveOrgDek(getKek(), orgId);
      dekCache.set(orgId, dek);
    }
    return dek;
  };
  return {
    seal(orgId, plaintext) {
      return { cipher: sealMessageBody(plaintext, dekFor(orgId)), sha256: messageBodySha256(plaintext) };
    },
    open(orgId, cipher) {
      return openMessageBody(cipher, dekFor(orgId));
    },
  };
}

/** The active members of a channel (removed_at IS NULL), scoped to the org. */
export async function activeMemberIds(tx: Tx, orgId: string, channelId: string): Promise<string[]> {
  const rows = (await tx
    .select({ userId: CM.userId })
    .from(CM)
    .where(and(eq(CM.organizationId, orgId), eq(CM.channelId, channelId), isNull(CM.removedAt)))) as Array<{
    userId: string;
  }>;
  return rows.map((r) => r.userId);
}

/**
 * Insert an envelope-encrypted message and fan out a `delivered` receipt to every active member
 * except the author (§3.4 receipts). The caller has already resolved the channel + archive gate.
 */
export async function insertEncryptedMessage(
  tx: Tx,
  cipher: MessageBodyCipher,
  args: {
    orgId: string;
    channelId: string;
    authorUserId: string | null;
    body: string;
    bodyKind?: MessageBodyKind;
    parentMessageId?: string | null;
    quotedMessageId?: string | null;
  },
): Promise<{ messageId: string; createdAt: string }> {
  const { cipher: bodyCipher, sha256 } = cipher.seal(args.orgId, args.body);
  const inserted = (await tx
    .insert(MSG)
    .values({
      channelId: args.channelId,
      organizationId: args.orgId,
      authorUserId: args.authorUserId,
      authorKind: args.authorUserId ? "user" : "system",
      bodyCipher,
      bodySha256: sha256,
      bodyKind: args.bodyKind ?? "plain",
      parentMessageId: args.parentMessageId ?? null,
      quotedMessageId: args.quotedMessageId ?? null,
    })
    .returning({ id: MSG.id, createdAt: MSG.createdAt })) as Array<{ id: string; createdAt: Date }>;
  const messageId = inserted[0]!.id;
  const createdAt = inserted[0]!.createdAt;

  const recipients = (await activeMemberIds(tx, args.orgId, args.channelId)).filter(
    (uid) => uid !== args.authorUserId,
  );
  if (recipients.length > 0) {
    await tx.insert(MR).values(
      recipients.map((userId) => ({
        organizationId: args.orgId,
        messageId,
        userId,
        status: "delivered" as const,
      })),
    );
  }
  return { messageId, createdAt: createdAt.toISOString() };
}

/**
 * Mark message(s) read for a user (§3.4): flip the actor's `delivered` receipts to `read` (single
 * message, or every earlier message in the channel when `upTo`) and advance the channel-member
 * read pointer. NOT_FOUND if the message is absent / cross-org.
 */
export async function markMessagesRead(
  tx: Tx,
  args: { orgId: string; userId: string; messageId: string; upTo?: boolean },
): Promise<void> {
  const target = (await tx
    .select({ id: MSG.id, channelId: MSG.channelId, createdAt: MSG.createdAt })
    .from(MSG)
    .where(and(eq(MSG.organizationId, args.orgId), eq(MSG.id, args.messageId)))
    .limit(1)) as Array<{ id: string; channelId: string; createdAt: Date }>;
  const msg = target[0];
  if (!msg) throw new NotFoundError("message", args.messageId);

  let messageIds: string[] = [args.messageId];
  if (args.upTo) {
    const earlier = (await tx
      .select({ id: MSG.id })
      .from(MSG)
      .where(
        and(
          eq(MSG.organizationId, args.orgId),
          eq(MSG.channelId, msg.channelId),
          lte(MSG.createdAt, msg.createdAt),
        ),
      )
      .orderBy(asc(MSG.createdAt))) as Array<{ id: string }>;
    messageIds = earlier.map((r) => r.id);
  }

  await tx
    .update(MR)
    .set({ status: "read", readAt: new Date() })
    .where(
      and(
        eq(MR.organizationId, args.orgId),
        eq(MR.userId, args.userId),
        eq(MR.status, "delivered"),
        inArray(MR.messageId, messageIds),
      ),
    );

  // Advance the canonical read pointer (§3.4). Active membership only — a non-member markRead is a
  // no-op pointer update (the receipt flip above already matched no rows).
  await tx
    .update(CM)
    .set({ lastReadMessageId: args.messageId })
    .where(
      and(
        eq(CM.organizationId, args.orgId),
        eq(CM.channelId, msg.channelId),
        eq(CM.userId, args.userId),
        isNull(CM.removedAt),
      ),
    );
}

/** Resolve a channel row (kind + archive state) inside the org, or NOT_FOUND. */
export async function channelOr404(
  tx: Tx,
  orgId: string,
  channelId: string,
): Promise<{ id: string; kind: string; isArchived: boolean }> {
  const rows = (await tx
    .select({ id: CH.id, kind: CH.channelKind, isArchived: CH.isArchived })
    .from(CH)
    .where(and(eq(CH.organizationId, orgId), eq(CH.id, channelId)))
    .limit(1)) as Array<{ id: string; kind: string; isArchived: boolean }>;
  if (!rows[0]) throw new NotFoundError("channel", channelId);
  return rows[0];
}
