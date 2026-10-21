// apps/backend/src/modules/36-messaging/reaction-pin-service-db.ts - WP 2.4: reactions and pins over Drizzle.
//
// ACCESS: the route has already run `channel_visibility` on the channel id; this service re-runs it (`canViewChannel`,
// the same predicate) so it is correct when called without the route, and scopes every statement to
// (organization, channel, message). A message that is unknown, in another channel, in another org or deleted is the
// one 404 a random id gets. An archived channel is read only (410), like a send.
//
// SEMANTICS: a reaction is a non-clinical social signal. Nothing here reads or writes `message_receipt`, so a
// reaction can never become, replace or imply a read receipt or a sign-off. Pin and unpin are audited by the
// `message_pin` write-audit trigger (actor = the session user). Both operations are idempotent; the realtime hint
// (`m36.message.annotated`, ids and one timestamp) is published only when a row actually changed.
import { type DbClient, schema } from "@wardenx/db";
import type { MessageReactionPinService, MessagingRouteService } from "@wardenx/messaging";
import { withOrgContext } from "@wardenx/tenancy";
import {
  MAX_PINS_PER_CHANNEL,
  NotFoundError,
  ChartWardenError,
  isMessageReactionKey,
} from "@wardenx/types";
import { and, desc, eq, sql } from "drizzle-orm";
import { loadReactionSummaries } from "./message-annotations";
import { type HintOutboxPort, publishMessageHint } from "./message-hint-events";
import {
  type HydrationContext,
  MESSAGE_ROW_COLUMNS,
  hydrateMessages,
} from "./messaging-message-hydration";
import type { Tx } from "./messaging-write-core";

const CH = schema.channels;
const MSG = schema.messages;
const MRX = schema.messageReactions;
const MPIN = schema.messagePins;
const USER = schema.users;

export interface ReactionPinDeps {
  readonly db: DbClient;
  readonly canViewChannel: MessagingRouteService["canViewChannel"];
  readonly outbox?: HintOutboxPort;
  readonly hydrationContext: (
    orgId: string,
    viewerUserId: string,
    channelKind: string,
  ) => HydrationContext;
}

interface LiveMessage {
  readonly parentMessageId: string | null;
}

export function createDbReactionPinService(deps: ReactionPinDeps): MessageReactionPinService {
  const { db } = deps;

  /** The channel's 404 for a non-member (no oracle), then the message's, then the archive's 410. */
  async function liveMessageInTx(
    tx: Tx,
    orgId: string,
    input: { channelId: string; messageId: string },
  ): Promise<LiveMessage> {
    const [row] = await tx
      .select({
        status: MSG.status,
        parentMessageId: MSG.parentMessageId,
        isArchived: CH.isArchived,
      })
      .from(MSG)
      .innerJoin(CH, and(eq(CH.organizationId, MSG.organizationId), eq(CH.id, MSG.channelId)))
      .where(
        and(
          eq(MSG.organizationId, orgId),
          eq(MSG.channelId, input.channelId),
          eq(MSG.id, input.messageId),
        ),
      )
      .limit(1);
    if (!row || row.status === "deleted") throw new NotFoundError("message", input.messageId);
    if (row.isArchived) throw new ChartWardenError("CHANNEL_ARCHIVED", "channel is archived", 410);
    return { parentMessageId: row.parentMessageId };
  }

  async function assertMember(orgId: string, userId: string, channelId: string): Promise<void> {
    if (!(await deps.canViewChannel(orgId, userId, channelId))) {
      throw new NotFoundError("channel", channelId);
    }
  }

  async function hint(
    tx: Tx,
    orgId: string,
    input: { channelId: string; messageId: string },
    message: LiveMessage,
  ): Promise<void> {
    await publishMessageHint(deps.outbox, tx, "annotated", {
      orgId,
      channelId: input.channelId,
      messageId: input.messageId,
      parentMessageId: message.parentMessageId,
      at: new Date(),
    });
  }

  return {
    async setReaction(orgId, input) {
      if (!isMessageReactionKey(input.emoji)) {
        throw new ChartWardenError("INVALID_REACTION", "unknown reaction", 422);
      }
      await assertMember(orgId, input.userId, input.channelId);
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        const message = await liveMessageInTx(tx, orgId, input);
        const changed = input.present
          ? await tx
              .insert(MRX)
              .values({
                organizationId: orgId,
                channelId: input.channelId,
                messageId: input.messageId,
                userId: input.userId,
                emoji: input.emoji,
              })
              .onConflictDoNothing()
              .returning({ id: MRX.id })
          : await tx
              .delete(MRX)
              .where(
                and(
                  eq(MRX.organizationId, orgId),
                  eq(MRX.channelId, input.channelId),
                  eq(MRX.messageId, input.messageId),
                  eq(MRX.userId, input.userId),
                  eq(MRX.emoji, input.emoji),
                ),
              )
              .returning({ id: MRX.id });
        if (changed.length > 0) await hint(tx, orgId, input, message);
        const summaries = await loadReactionSummaries(tx, {
          orgId,
          channelId: input.channelId,
          viewerUserId: input.userId,
          messageIds: [input.messageId],
        });
        return { reactions: summaries.get(input.messageId) ?? [] };
      });
    },

    async pinMessage(orgId, input) {
      await assertMember(orgId, input.userId, input.channelId);
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        // Serialise pins per channel so two racing pins cannot both slip under the cap. Taken BEFORE the liveness
        // read: a message delete takes the same lock, so either it commits first (this pin then sees it deleted) or
        // it waits for this pin and frees it.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.channelId}, 36))`,
        );
        const message = await liveMessageInTx(tx, orgId, input);
        const [existing] = await tx
          .select({ createdAt: MPIN.createdAt })
          .from(MPIN)
          .where(
            and(
              eq(MPIN.organizationId, orgId),
              eq(MPIN.channelId, input.channelId),
              eq(MPIN.messageId, input.messageId),
            ),
          )
          .limit(1);
        if (existing) return { pinnedAt: existing.createdAt.toISOString() };
        const [{ n }] = (await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(MPIN)
          .where(and(eq(MPIN.organizationId, orgId), eq(MPIN.channelId, input.channelId)))) as [
          { n: number },
        ];
        if (Number(n) >= MAX_PINS_PER_CHANNEL) {
          throw new ChartWardenError(
            "PIN_LIMIT_REACHED",
            `a channel can pin at most ${MAX_PINS_PER_CHANNEL} messages`,
            409,
          );
        }
        const [created] = await tx
          .insert(MPIN)
          .values({
            organizationId: orgId,
            channelId: input.channelId,
            messageId: input.messageId,
            pinnedByUserId: input.userId,
          })
          .returning({ createdAt: MPIN.createdAt });
        await hint(tx, orgId, input, message);
        return { pinnedAt: created!.createdAt.toISOString() };
      });
    },

    async unpinMessage(orgId, input) {
      await assertMember(orgId, input.userId, input.channelId);
      await withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        const [channel] = await tx
          .select({ isArchived: CH.isArchived })
          .from(CH)
          .where(and(eq(CH.organizationId, orgId), eq(CH.id, input.channelId)))
          .limit(1);
        if (!channel) throw new NotFoundError("channel", input.channelId);
        if (channel.isArchived)
          throw new ChartWardenError("CHANNEL_ARCHIVED", "channel is archived", 410);
        const removed = await tx
          .delete(MPIN)
          .where(
            and(
              eq(MPIN.organizationId, orgId),
              eq(MPIN.channelId, input.channelId),
              eq(MPIN.messageId, input.messageId),
            ),
          )
          .returning({ id: MPIN.id });
        if (removed.length === 0) return;
        // The message may be a tombstone by now; the hint only needs its (possible) parent for thread refresh.
        const [m] = await tx
          .select({ parentMessageId: MSG.parentMessageId })
          .from(MSG)
          .where(and(eq(MSG.organizationId, orgId), eq(MSG.id, input.messageId)))
          .limit(1);
        await hint(tx, orgId, input, { parentMessageId: m?.parentMessageId ?? null });
      });
    },

    async listPins(orgId, input) {
      await assertMember(orgId, input.userId, input.channelId);
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        const [channel] = await tx
          .select({ kind: CH.channelKind, subjectId: CH.subjectId })
          .from(CH)
          .where(and(eq(CH.organizationId, orgId), eq(CH.id, input.channelId)))
          .limit(1);
        if (!channel) throw new NotFoundError("channel", input.channelId);
        const rows = await tx
          .select(MESSAGE_ROW_COLUMNS)
          .from(MPIN)
          .innerJoin(
            MSG,
            and(
              eq(MSG.organizationId, MPIN.organizationId),
              eq(MSG.channelId, MPIN.channelId),
              eq(MSG.id, MPIN.messageId),
            ),
          )
          .leftJoin(USER, eq(USER.id, MSG.authorUserId))
          .where(
            and(
              eq(MPIN.organizationId, orgId),
              eq(MPIN.channelId, input.channelId),
              sql`${MSG.status} <> 'deleted'`,
            ),
          )
          .orderBy(desc(MPIN.createdAt), desc(MPIN.id))
          .limit(MAX_PINS_PER_CHANNEL);
        const pins = await hydrateMessages(
          tx,
          deps.hydrationContext(orgId, input.userId, channel.kind),
          rows,
          input.channelId,
        );
        return {
          pins,
          patientId: channel.kind === "care_team" ? channel.subjectId : null,
        };
      });
    },
  };
}
