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
  bodyEnvelopeScheme,
  deriveOrgDek,
  loadMessagingKek,
  messageBodySha256,
  openMessageBody,
  openMessageBodyRing,
  ringEnvelopeVersion,
  sealMessageBody,
  sealMessageBodyRing,
} from "@wardenx/messaging";
import type { RingBodyDek } from "@wardenx/messaging";
import type { MessageBodyKind } from "@wardenx/messaging";
import {
  IdempotencyConflictError,
  NotFoundError,
  type RichBody,
  ValidationError,
  ChartWardenError,
} from "@wardenx/types";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { recordAnnouncementReads } from "./announcement-receipts";
import {
  BodyKeyUnavailableError,
  type MessageBodyKeyProvider,
  type RingDekCache,
  createRingDekCache,
  sharedRingDekCache,
} from "./body-key-ring";
import { storedBodyFor } from "./rich-body-codec";

const CH = schema.channels;
const CM = schema.channelMembers;
const MSG = schema.messages;
const MR = schema.messageReceipts;
const MEMBERSHIP = schema.memberships;
const USER = schema.users;

export function blankMessageError(): ValidationError {
  return new ValidationError("a message needs text or at least one attachment", [
    { field: "body", code: "REQUIRED", message: "text or an attachment is required" },
  ]);
}

/**
 * The one rule for what a message may be (WP 1.5): text OR at least one attachment. Returns the input with a blank body
 * normalised to the empty string (stored and sealed like any other body), or throws. Shared by the route service and the
 * MessagingProvider seam so no caller can create a blank message.
 */
export function withValidMessageContent<
  T extends { body: string; attachments?: readonly unknown[] | undefined },
>(input: T): T {
  if (input.body.trim()) return input;
  if (!input.attachments?.length) throw blankMessageError();
  return { ...input, body: "" };
}

/** A Drizzle transaction handle (the structural type the DbClient hands its `transaction` callback). */
export type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** Which envelope NEW writes use. `legacy` = HKDF(MESSAGING_ENCRYPTION_KEY, org); `ring` = the M34 wrapped-DEK ring. */
export type BodySealScheme = "legacy" | "ring";

/** `M36_BODY_SEAL_SCHEME` (default `legacy`: ring writes are switched on only after the read-both release soaked). */
export function bodySealSchemeFromEnv(env: NodeJS.ProcessEnv = process.env): BodySealScheme {
  const raw = env.M36_BODY_SEAL_SCHEME?.trim().toLowerCase();
  if (!raw || raw === "legacy") return "legacy";
  if (raw === "ring") return "ring";
  throw new Error(`M36_BODY_SEAL_SCHEME must be 'legacy' or 'ring' (got '${raw}')`);
}

/**
 * Per-tenant message body cipher (FB-T05; WP 2.13 / ADR-0058 P1). READS open either envelope: the first byte of the
 * stored bytea picks the key (1 = legacy HKDF key, 2 = M34 ring DEK of the version the envelope names). WRITES seal under
 * the configured scheme; {@link sealRing} always seals under the ring (the backfill). The legacy KEK loads lazily (the
 * first legacy seal/open) so a deployment without MESSAGING_ENCRYPTION_KEY still boots and serves ring rows; a legacy
 * operation then fails CLOSED. Async because the ring DEK comes from the M34 provider (cached, see body-key-ring.ts).
 */
export interface MessageBodyCipher {
  /** Seal a plaintext under the configured scheme + compute the pre-encryption integrity digest. */
  seal(orgId: string, plaintext: string): Promise<{ cipher: Buffer; sha256: string }>;
  /** Seal under the tenant ring DEK regardless of the configured scheme (backfill; the digest is of the plaintext). */
  sealRing(orgId: string, plaintext: string): Promise<{ cipher: Buffer; sha256: string }>;
  /** Decrypt a `body_cipher` bytea, either scheme (entitled-reader path only). */
  open(orgId: string, cipher: Buffer): Promise<string>;
}

/** Build the lazy, per-process {@link MessageBodyCipher}. `kek`, `keys`, `ringCache` and `sealScheme` are injectable for tests. */
export function createMessageBodyCipher(
  opts: {
    kek?: Buffer;
    keys?: MessageBodyKeyProvider;
    ringCache?: RingDekCache;
    sealScheme?: BodySealScheme;
  } = {},
): MessageBodyCipher {
  let kek: Buffer | undefined = opts.kek;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic lazy memoization via ??=.
  const getKek = (): Buffer => (kek ??= loadMessagingKek());
  const legacyDeks = new Map<string, Buffer>();
  const legacyDek = (orgId: string): Buffer => {
    let dek = legacyDeks.get(orgId);
    if (!dek) {
      dek = deriveOrgDek(getKek(), orgId);
      legacyDeks.set(orgId, dek);
    }
    return dek;
  };
  const ownCache = opts.keys ? createRingDekCache(opts.keys) : undefined;
  const ring = (): RingDekCache => {
    const cache = opts.ringCache ?? ownCache ?? sharedRingDekCache();
    if (!cache) {
      throw new Error(
        "message body ring key provider is not bound (setMessageBodyKeyProvider) — fail-closed",
      );
    }
    return cache;
  };
  const sealRing = async (orgId: string, plaintext: string) => {
    let dek: RingBodyDek;
    try {
      dek = await ring().current(orgId);
    } catch (err) {
      throw new BodyKeyUnavailableError(err);
    }
    return {
      cipher: sealMessageBodyRing(plaintext, dek, orgId),
      sha256: messageBodySha256(plaintext),
    };
  };
  return {
    sealRing,
    async seal(orgId, plaintext) {
      if ((opts.sealScheme ?? bodySealSchemeFromEnv()) === "ring")
        return sealRing(orgId, plaintext);
      return {
        cipher: sealMessageBody(plaintext, legacyDek(orgId)),
        sha256: messageBodySha256(plaintext),
      };
    },
    async open(orgId, cipher) {
      const scheme = bodyEnvelopeScheme(cipher);
      // Key lookup failures are infrastructure (BodyKeyUnavailableError); only the GCM open below is a statement about the bytes.
      if (scheme === "legacy") {
        let dek: Buffer;
        try {
          dek = legacyDek(orgId);
        } catch (err) {
          throw new BodyKeyUnavailableError(err);
        }
        return openMessageBody(cipher, dek);
      }
      if (scheme === "ring") {
        let dek: RingBodyDek;
        try {
          dek = await ring().byVersion(orgId, ringEnvelopeVersion(cipher));
        } catch (err) {
          throw new BodyKeyUnavailableError(err);
        }
        return openMessageBodyRing(cipher, dek.key, orgId);
      }
      throw new Error(`message body-crypto: cannot open a ${scheme} envelope`);
    },
  };
}

/** The active members of a channel (removed_at IS NULL), scoped to the org. */
export async function activeMemberIds(tx: Tx, orgId: string, channelId: string): Promise<string[]> {
  const rows = (await tx
    .select({ userId: CM.userId })
    .from(CM)
    .innerJoin(CH, and(eq(CH.id, CM.channelId), eq(CH.organizationId, CM.organizationId)))
    .leftJoin(
      MEMBERSHIP,
      and(
        eq(MEMBERSHIP.organizationId, CM.organizationId),
        eq(MEMBERSHIP.userId, CM.userId),
        eq(MEMBERSHIP.status, "active"),
      ),
    )
    .innerJoin(USER, and(eq(USER.id, CM.userId), eq(USER.status, "active")))
    .where(
      and(
        eq(CM.organizationId, orgId),
        eq(CM.channelId, channelId),
        isNull(CM.removedAt),
        or(eq(CM.role, "portal_caregiver"), isNotNull(MEMBERSHIP.id)),
      ),
    )) as Array<{
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
    /** WP 2.1: a structured body. Stored as its canonical JSON under `body_kind = 'rich'`; `body` is its projection. */
    richBody?: RichBody;
    parentMessageId?: string | null;
    quotedMessageId?: string | null;
    /** WP 1.2 DB backstop: stable across client retries; a second insert returns the original row. */
    clientMessageId?: string | null;
    /** WP 4.1: set only by the urgent entry; stores `urgency = 'urgent'` with this recipient (fixed at send). */
    urgentRecipientUserId?: string | null;
  },
): Promise<{ messageId: string; createdAt: string; replayed: boolean }> {
  // Audit F5 / WP 1.7: a reply's parent and a quote's target must be in the same channel. A missing, cross-org or
  // other-channel id is one answer, so the check is not an existence oracle for messages in channels the sender cannot
  // see (and a quote is never stored as a dangling cross-tenant reference: the FK check ignores RLS).
  for (const [id, code, what] of [
    [args.parentMessageId, "PARENT_MESSAGE_NOT_IN_CHANNEL", "a reply's parent"],
    [args.quotedMessageId, "QUOTED_MESSAGE_NOT_IN_CHANNEL", "a quoted"],
  ] as const) {
    if (!id) continue;
    const found = (await tx
      .select({ channelId: MSG.channelId, parentMessageId: MSG.parentMessageId })
      .from(MSG)
      .where(and(eq(MSG.organizationId, args.orgId), eq(MSG.id, id)))
      .limit(1)) as Array<{ channelId: string; parentMessageId: string | null }>;
    if (found[0]?.channelId !== args.channelId) {
      throw new ChartWardenError(code, `${what} message must be in the same channel`, 422);
    }
    // WP 2.2: threads are one level. A reply's parent is a thread root, never another reply (quoting a reply is fine).
    if (id === args.parentMessageId && found[0]?.parentMessageId) {
      throw new ChartWardenError(
        "PARENT_MESSAGE_IS_REPLY",
        "a reply must target the thread's root message, not another reply",
        422,
      );
    }
  }
  const stored = storedBodyFor(args);
  const { cipher: bodyCipher, sha256 } = await cipher.seal(args.orgId, stored.plaintext);
  const inserted = (await tx
    .insert(MSG)
    .values({
      channelId: args.channelId,
      organizationId: args.orgId,
      authorUserId: args.authorUserId,
      authorKind: args.authorUserId ? "user" : "system",
      bodyCipher,
      bodySha256: sha256,
      bodyKind: stored.bodyKind,
      parentMessageId: args.parentMessageId ?? null,
      quotedMessageId: args.quotedMessageId ?? null,
      clientMessageId: args.clientMessageId ?? null,
      ...(args.urgentRecipientUserId
        ? { urgency: "urgent" as const, urgentRecipientUserId: args.urgentRecipientUserId }
        : {}),
    })
    // Concurrent duplicates serialize on the unique index: the loser waits for the winner's commit, then
    // inserts nothing. A null `client_message_id` never conflicts, so unkeyed writes are unaffected.
    .onConflictDoNothing({ target: [MSG.organizationId, MSG.authorUserId, MSG.clientMessageId] })
    .returning({ id: MSG.id, createdAt: MSG.createdAt })) as Array<{ id: string; createdAt: Date }>;
  if (!inserted[0]) return replayOriginal(tx, args, sha256);
  const messageId = inserted[0].id;
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
  return { messageId, createdAt: createdAt.toISOString(), replayed: false };
}

/**
 * The (org, author, client_message_id) slot is taken: return the original message so the retry is a replay.
 * A reused id for a different channel or body is a caller bug, not a retry — the same 409 the HTTP middleware
 * gives a reused Idempotency-Key with a different body.
 */
async function replayOriginal(
  tx: Tx,
  args: {
    orgId: string;
    channelId: string;
    authorUserId: string | null;
    clientMessageId?: string | null;
    urgentRecipientUserId?: string | null;
  },
  sha256: string,
): Promise<{ messageId: string; createdAt: string; replayed: true }> {
  const rows = (await tx
    .select({
      id: MSG.id,
      createdAt: MSG.createdAt,
      channelId: MSG.channelId,
      sha: MSG.bodySha256,
      urgentRecipient: MSG.urgentRecipientUserId,
    })
    .from(MSG)
    .where(
      and(
        eq(MSG.organizationId, args.orgId),
        args.authorUserId ? eq(MSG.authorUserId, args.authorUserId) : isNull(MSG.authorUserId),
        eq(MSG.clientMessageId, args.clientMessageId!),
      ),
    )
    .limit(1)) as Array<{
    id: string;
    createdAt: Date;
    channelId: string;
    sha: string;
    urgentRecipient: string | null;
  }>;
  const original = rows[0];
  // WP 4.1: a reused id naming a different urgent recipient (or turning a routine send urgent) is a caller bug, not a retry.
  if (
    !original ||
    original.channelId !== args.channelId ||
    original.sha !== sha256 ||
    original.urgentRecipient !== (args.urgentRecipientUserId ?? null)
  ) {
    throw new IdempotencyConflictError();
  }
  return { messageId: original.id, createdAt: original.createdAt.toISOString(), replayed: true };
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
          // Compare against the boundary row inside PostgreSQL. Converting timestamptz to a JS Date
          // truncates microseconds and can otherwise leave the boundary receipt unread.
          sql`(${MSG.createdAt}, ${MSG.id}) <= (
            SELECT boundary.created_at, boundary.id
            FROM message AS boundary
            WHERE boundary.organization_id = ${args.orgId}::uuid
              AND boundary.id = ${args.messageId}::uuid
          )`,
        ),
      )
      .orderBy(asc(MSG.createdAt))) as Array<{ id: string }>;
    messageIds = earlier.map((r) => r.id);
  }

  // WP 2.9: the announcement channel has no members, hence no `delivered` receipts to flip; record the reads directly.
  const channel = (await tx
    .select({ kind: CH.channelKind })
    .from(CH)
    .where(and(eq(CH.organizationId, args.orgId), eq(CH.id, msg.channelId)))
    .limit(1)) as Array<{ kind: string }>;
  if (channel[0]?.kind === "announcement") {
    await recordAnnouncementReads(tx, { orgId: args.orgId, userId: args.userId, messageIds });
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
