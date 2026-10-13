// apps/backend/src/modules/36-messaging/scheduled/scheduled-send-service-db.ts — WP 2.6: the request-side half of
// scheduled send (create / list mine / cancel / reschedule). The body is sealed under the tenant DEK (the same envelope
// as message.body_cipher and drafts); only the schedule, state and reason code are plaintext. Every statement runs under
// withOrgContext with the CALLER as the context user: RLS (migration 1087) pins rows to org AND owner, and the queries
// below also name the owner, so a forgotten filter cannot surface a colleague's row. Org and user come from the
// server-side request context, never the body. The routes have already authorised the channel (channel_visibility,
// messaging.send, and messaging.announce for the announcement channel); the SEND is authorised again at dispatch.
import { type DbClient, schema } from "@wardenx/db";
import {
  type CreateScheduledMessageInput,
  DEFAULT_MAX_SCHEDULED_PER_USER,
  MAX_SCHEDULED_BODY_LENGTH,
  type ScheduleBlockReason,
  type ScheduledMessageView,
  type ScheduledSendService,
  assertScheduleTime,
  normalizeScheduleTimeZone,
} from "@wardenx/messaging";
import { withOrgContext } from "@wardenx/tenancy";
import { ConflictError, NotFoundError, ValidationError, WardenXError } from "@wardenx/types";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  type MessageBodyCipher,
  type Tx,
  blankMessageError,
  channelOr404,
  createMessageBodyCipher,
} from "../messaging-write-core";

const SM = schema.scheduledMessages;
const MDRAFT = schema.messageDrafts;
const MSG = schema.messages;
/** The most rows one list call returns; the per-user cap is far below it. */
const LIST_LIMIT = 200;

export interface ScheduledSendServiceDeps {
  readonly db: DbClient;
  /** Injectable for tests; defaults to the process-wide lazy KEK loader (fails closed without MESSAGING_ENCRYPTION_KEY). */
  readonly cipher?: MessageBodyCipher;
  /** Scheduled messages (pending + blocked) one user may hold (default 50). */
  readonly maxPerUser?: number;
  /** The route service's visibility rule: a blocked row is only revived for a sender who can still see its channel. */
  readonly canViewChannel: (orgId: string, userId: string, channelId: string) => Promise<boolean>;
  /** Injectable clock (tests). */
  readonly now?: () => Date;
}

function viewOf(
  cipher: MessageBodyCipher,
  orgId: string,
  row: typeof SM.$inferSelect,
): ScheduledMessageView {
  return {
    id: row.id,
    channelId: row.channelId,
    parentMessageId: row.parentMessageId,
    body: cipher.open(orgId, row.bodyCipher),
    scheduledFor: row.scheduledFor.toISOString(),
    timeZone: row.timeZone,
    status: row.status as ScheduledMessageView["status"],
    blockedReason: row.blockedReason as ScheduleBlockReason | null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A scheduled reply needs a live thread root in THIS channel (the composite FK is the backstop, this is the 404). */
async function assertLiveRoot(tx: Tx, orgId: string, channelId: string, rootId: string) {
  const [root] = await tx
    .select({ status: MSG.status, parentMessageId: MSG.parentMessageId })
    .from(MSG)
    .where(and(eq(MSG.organizationId, orgId), eq(MSG.channelId, channelId), eq(MSG.id, rootId)))
    .limit(1);
  if (!root || root.status === "deleted" || root.parentMessageId !== null) {
    throw new NotFoundError("message", rootId);
  }
}

export function createDbScheduledSendService(deps: ScheduledSendServiceDeps): ScheduledSendService {
  const { db } = deps;
  const cipher = deps.cipher ?? createMessageBodyCipher();
  const maxPerUser = deps.maxPerUser ?? DEFAULT_MAX_SCHEDULED_PER_USER;
  const clock = deps.now ?? (() => new Date());

  const create = async (
    orgId: string,
    input: CreateScheduledMessageInput,
  ): Promise<ScheduledMessageView> => {
    if (input.body.trim() === "") throw blankMessageError();
    if (input.body.length > MAX_SCHEDULED_BODY_LENGTH) {
      throw new ValidationError("message is too long", [
        {
          field: "body",
          code: "TOO_LONG",
          message: `at most ${MAX_SCHEDULED_BODY_LENGTH} characters`,
        },
      ]);
    }
    const when = assertScheduleTime(input.scheduledFor, clock());
    const timeZone = normalizeScheduleTimeZone(input.timeZone);
    const sealed = cipher.seal(orgId, input.body).cipher;
    return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
      const channel = await channelOr404(tx, orgId, input.channelId);
      if (channel.isArchived)
        throw new WardenXError("CHANNEL_ARCHIVED", "channel is archived", 410);
      if (input.parentMessageId) {
        await assertLiveRoot(tx, orgId, input.channelId, input.parentMessageId);
      }
      // Serialise this user's creates so the cap cannot be raced past, then count (this user only: RLS).
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`scheduled:${orgId}:${input.userId}`}, 36))`,
      );
      const [{ n }] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(SM)
        .where(and(eq(SM.organizationId, orgId), eq(SM.userId, input.userId)))) as [{ n: number }];
      if (Number(n) >= maxPerUser) {
        throw new WardenXError(
          "SCHEDULE_LIMIT_REACHED",
          `at most ${maxPerUser} messages can be scheduled; send or cancel one first`,
          409,
        );
      }
      const [created] = await tx
        .insert(SM)
        .values({
          organizationId: orgId,
          channelId: input.channelId,
          userId: input.userId,
          parentMessageId: input.parentMessageId ?? null,
          bodyCipher: sealed,
          scheduledFor: when,
          timeZone,
        })
        .returning();
      // Tranche C: the text left the composer for the schedule, so the sender's OWN draft for this slot goes in the
      // same transaction, exactly as a live send does (a client that closes mid-schedule cannot save it back). Done at
      // creation, not dispatch: at dispatch a NEWER draft for the slot may exist and must not be clobbered.
      await tx
        .delete(MDRAFT)
        .where(
          and(
            eq(MDRAFT.organizationId, orgId),
            eq(MDRAFT.userId, input.userId),
            eq(MDRAFT.channelId, input.channelId),
            input.parentMessageId
              ? eq(MDRAFT.parentMessageId, input.parentMessageId)
              : isNull(MDRAFT.parentMessageId),
          ),
        );
      return viewOf(cipher, orgId, created as typeof SM.$inferSelect);
    });
  };

  const listMine: ScheduledSendService["listMine"] = (orgId, input) =>
    withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
      const found = await tx
        .select()
        .from(SM)
        .where(
          and(
            eq(SM.organizationId, orgId),
            eq(SM.userId, input.userId),
            input.channelId ? eq(SM.channelId, input.channelId) : undefined,
          ),
        )
        .orderBy(asc(SM.scheduledFor), asc(SM.id))
        .limit(LIST_LIMIT);
      return found.map((row) => viewOf(cipher, orgId, row));
    });

  const cancel: ScheduledSendService["cancel"] = (orgId, input) =>
    withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
      const removed = await tx
        .delete(SM)
        .where(and(eq(SM.organizationId, orgId), eq(SM.userId, input.userId), eq(SM.id, input.id)))
        .returning({ id: SM.id });
      return { cancelled: removed.length > 0 };
    });

  const reschedule: ScheduledSendService["reschedule"] = async (orgId, input) => {
    const when = assertScheduleTime(input.scheduledFor, clock());
    // The visibility lookup opens its own connection, so it must never run while this one holds a pooled connection
    // and the row lock (a burst of PATCHes would exhaust the pool waiting on itself). Peek, check outside any
    // transaction, then lock and confirm the row is still in the state that was verified.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const [peek] = await withOrgContext(
        db,
        { organizationId: orgId, userId: input.userId },
        (tx) =>
          tx
            .select({ channelId: SM.channelId, status: SM.status })
            .from(SM)
            .where(
              and(eq(SM.organizationId, orgId), eq(SM.userId, input.userId), eq(SM.id, input.id)),
            )
            .limit(1),
      );
      if (!peek) throw new NotFoundError("scheduled_message", input.id);
      // A blocked row went back to pending on a bare PATCH: the dispatcher would re-block it and tell the sender
      // again. Re-verify the way create does (visibility), and answer the one 404 an unknown row gets.
      if (
        peek.status === "blocked" &&
        !(await deps.canViewChannel(orgId, input.userId, peek.channelId))
      ) {
        throw new NotFoundError("scheduled_message", input.id);
      }
      const outcome = await withOrgContext(
        db,
        { organizationId: orgId, userId: input.userId },
        async (tx) => {
          // Lock: a dispatcher that claimed the row finishes (and deletes it) before this sees it, so a reschedule
          // can never resurrect a message that already went out.
          const [held] = await tx
            .select({ id: SM.id, status: SM.status })
            .from(SM)
            .where(
              and(eq(SM.organizationId, orgId), eq(SM.userId, input.userId), eq(SM.id, input.id)),
            )
            .limit(1)
            .for("update");
          if (!held) throw new NotFoundError("scheduled_message", input.id);
          // It became blocked after the peek: its visibility was not verified. Check again, outside the transaction.
          if (held.status === "blocked" && peek.status !== "blocked") return "recheck" as const;
          const [updated] = await tx
            .update(SM)
            .set({
              scheduledFor: when,
              status: "pending",
              blockedReason: null,
              attempts: 0,
              updatedAt: new Date(),
            })
            .where(and(eq(SM.organizationId, orgId), eq(SM.id, input.id)))
            .returning();
          return viewOf(cipher, orgId, updated as typeof SM.$inferSelect);
        },
      );
      if (outcome !== "recheck") return outcome;
    }
    throw new ConflictError(
      "the scheduled message changed while it was being rescheduled; try again",
    );
  };

  return { create, listMine, cancel, reschedule };
}
