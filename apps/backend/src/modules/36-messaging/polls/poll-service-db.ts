// apps/backend/src/modules/36-messaging/polls/poll-service-db.ts - WP 2.10: single-choice, NAMED-vote polls.
//
// WRITE PATH: a poll IS a message. The question goes through the same write core a live send and a scheduled send use
// (`insertEncryptedMessage`: sealed body, receipt fan-out, client_message_id replay backstop) in the same transaction
// as the poll rows, followed by the same `m36.message.sent` hint, so ACL (route guards), rate limit (global limiter),
// audit (message + poll write triggers) and outbox events are the ones a message already has. No parallel path.
//
// NON-CLINICAL: refused in any channel kind that carries a patient link (derived from CHANNEL_KIND_DESCRIPTORS, so a
// future patient-linked kind is blocked without editing this file). Membership is re-checked here with the same
// `canViewChannel` predicate the route ran; a removed member gets the 404 a random id gets.
//
// VOTES: one per user per poll (unique key). A change is an UPDATE of option_id, audited by the vote table's trigger.
// A vote takes a SHARE lock on the poll row, a close takes the exclusive one, so a vote can never land after a close.
import { type DbClient, schema } from "@chartwarden/db";
import { CHANNEL_KIND_DESCRIPTORS, type MessagingRouteService } from "@chartwarden/messaging";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  ForbiddenError,
  NotFoundError,
  type PollDetailView,
  type PollView,
  ValidationError,
  checkPollInput,
} from "@chartwarden/types";
import { and, eq, sql } from "drizzle-orm";
import { type HintOutboxPort, publishMessageHint } from "../message-hint-events";
import {
  type MessageBodyCipher,
  type Tx,
  channelOr404,
  createMessageBodyCipher,
  insertEncryptedMessage,
} from "../messaging-write-core";
import { loadPollViews, loadPollVoters } from "./poll-views";

const MSG = schema.messages;
const CH = schema.channels;
const POLL = schema.messagePolls;
const OPT = schema.messagePollOptions;
const VOTE = schema.messagePollVotes;

export interface PollServiceDeps {
  readonly db: DbClient;
  readonly canViewChannel: MessagingRouteService["canViewChannel"];
  readonly outbox?: HintOutboxPort;
  /** Injectable for tests; defaults to the process-wide lazy cipher (fails closed without a key). */
  readonly cipher?: MessageBodyCipher;
}

export interface CreatePollInput {
  readonly userId: string;
  readonly channelId: string;
  readonly question: string;
  readonly options: readonly string[];
  readonly clientMessageId?: string | undefined;
}

export interface PollTarget {
  readonly userId: string;
  readonly channelId: string;
  readonly messageId: string;
}

export interface MessagePollService {
  createPoll(
    orgId: string,
    input: CreatePollInput,
  ): Promise<{ messageId: string; channelId: string; createdAt: string; poll: PollView }>;
  getPoll(orgId: string, input: PollTarget): Promise<PollDetailView>;
  vote(orgId: string, input: PollTarget & { optionId: string }): Promise<{ poll: PollView }>;
  /** `canManage`: the caller is a channel manager (the route decides with the existing member-admin predicate). */
  closePoll(orgId: string, input: PollTarget & { canManage: boolean }): Promise<{ poll: PollView }>;
}

/** Channel kinds whose subject is a patient or a patient's bereavement plan: no polls there. */
export function pollBlockedChannelKinds(): readonly string[] {
  return Object.values(CHANNEL_KIND_DESCRIPTORS)
    .filter((d) => d.subject === "patient_id" || d.subject === "bereavement_plan_id")
    .map((d) => d.kind);
}

const BLOCKED_KINDS: ReadonlySet<string> = new Set(pollBlockedChannelKinds());

export function createDbPollService(deps: PollServiceDeps): MessagePollService {
  const { db } = deps;
  const cipher = deps.cipher ?? createMessageBodyCipher();

  async function assertMember(orgId: string, userId: string, channelId: string): Promise<void> {
    if (!(await deps.canViewChannel(orgId, userId, channelId))) {
      throw new NotFoundError("channel", channelId);
    }
  }

  /** The poll for a live message of this channel, locked; archive is read only (410). */
  async function lockedPoll(
    tx: Tx,
    orgId: string,
    input: PollTarget,
    mode: "share" | "update",
  ): Promise<{ id: string; createdByUserId: string; closedAt: Date | null }> {
    const [state] = await tx
      .select({ status: MSG.status, isArchived: CH.isArchived })
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
    if (!state || state.status === "deleted") throw new NotFoundError("poll", input.messageId);
    if (state.isArchived)
      throw new ChartWardenError("CHANNEL_ARCHIVED", "channel is archived", 410);
    const [poll] = await tx
      .select({ id: POLL.id, createdByUserId: POLL.createdByUserId, closedAt: POLL.closedAt })
      .from(POLL)
      .where(
        and(
          eq(POLL.organizationId, orgId),
          eq(POLL.channelId, input.channelId),
          eq(POLL.messageId, input.messageId),
        ),
      )
      .limit(1)
      .for(mode);
    if (!poll) throw new NotFoundError("poll", input.messageId);
    return poll;
  }

  async function viewOf(tx: Tx, orgId: string, input: PollTarget): Promise<PollView> {
    const views = await loadPollViews(tx, {
      orgId,
      channelId: input.channelId,
      viewerUserId: input.userId,
      messageIds: [input.messageId],
      cipher,
    });
    const view = views.get(input.messageId);
    if (!view) throw new NotFoundError("poll", input.messageId);
    return view;
  }

  async function hint(tx: Tx, orgId: string, input: PollTarget): Promise<void> {
    await publishMessageHint(deps.outbox, tx, "annotated", {
      orgId,
      channelId: input.channelId,
      messageId: input.messageId,
      at: new Date(),
    });
  }

  return {
    async createPoll(orgId, input) {
      const checked = checkPollInput({ question: input.question, options: input.options });
      if (!checked.ok) {
        throw new ValidationError(
          "the poll is not valid",
          checked.problems.map((p) => ({
            field: p.field,
            code: `POLL_${p.problem.toUpperCase()}`,
            message: `${p.field}: ${p.problem}`,
          })),
        );
      }
      await assertMember(orgId, input.userId, input.channelId);
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        const channel = await channelOr404(tx, orgId, input.channelId);
        if (channel.isArchived) {
          throw new ChartWardenError("CHANNEL_ARCHIVED", "channel is archived", 410);
        }
        if (BLOCKED_KINDS.has(channel.kind)) {
          throw new ChartWardenError(
            "POLL_NOT_ALLOWED_IN_PATIENT_CHANNEL",
            "polls are non-clinical and cannot be created in a channel linked to a patient",
            422,
          );
        }
        const sent = await insertEncryptedMessage(tx, cipher, {
          orgId,
          channelId: input.channelId,
          authorUserId: input.userId,
          body: checked.question,
          bodyKind: "plain",
          clientMessageId: input.clientMessageId ?? null,
        });
        const target = {
          userId: input.userId,
          channelId: input.channelId,
          messageId: sent.messageId,
        };
        const result = {
          messageId: sent.messageId,
          channelId: input.channelId,
          createdAt: sent.createdAt,
        };
        // A retry of an already-committed create returns the original poll and writes nothing again.
        if (sent.replayed) return { ...result, poll: await viewOf(tx, orgId, target) };
        const [poll] = await tx
          .insert(POLL)
          .values({
            organizationId: orgId,
            channelId: input.channelId,
            messageId: sent.messageId,
            createdByUserId: input.userId,
          })
          .returning({ id: POLL.id });
        const sealed = await Promise.all(checked.options.map((label) => cipher.seal(orgId, label)));
        await tx.insert(OPT).values(
          sealed.map((s, position) => ({
            organizationId: orgId,
            pollId: poll!.id,
            position,
            labelCipher: s.cipher,
          })),
        );
        await publishMessageHint(deps.outbox, tx, "sent", {
          orgId,
          channelId: input.channelId,
          messageId: sent.messageId,
          at: sent.createdAt,
        });
        return { ...result, poll: await viewOf(tx, orgId, target) };
      });
    },

    async getPoll(orgId, input) {
      await assertMember(orgId, input.userId, input.channelId);
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        // A deleted message is a tombstone: its options and voters are no longer readable (404, like a random id).
        const [state] = await tx
          .select({ status: MSG.status })
          .from(MSG)
          .where(
            and(
              eq(MSG.organizationId, orgId),
              eq(MSG.channelId, input.channelId),
              eq(MSG.id, input.messageId),
            ),
          )
          .limit(1);
        if (!state || state.status === "deleted") throw new NotFoundError("poll", input.messageId);
        const view = await viewOf(tx, orgId, input);
        return { ...view, voters: await loadPollVoters(tx, { orgId, pollId: view.pollId }) };
      });
    },

    async vote(orgId, input) {
      await assertMember(orgId, input.userId, input.channelId);
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        const poll = await lockedPoll(tx, orgId, input, "share");
        if (poll.closedAt) throw new ChartWardenError("POLL_CLOSED", "this poll is closed", 409);
        const [option] = await tx
          .select({ id: OPT.id })
          .from(OPT)
          .where(
            and(eq(OPT.organizationId, orgId), eq(OPT.pollId, poll.id), eq(OPT.id, input.optionId)),
          )
          .limit(1);
        if (!option) {
          throw new ChartWardenError(
            "INVALID_POLL_OPTION",
            "that option is not part of this poll",
            422,
          );
        }
        // One vote per user: a first vote inserts, a different option updates (audited), the same option is a no-op.
        const changed = await tx
          .insert(VOTE)
          .values({
            organizationId: orgId,
            pollId: poll.id,
            optionId: option.id,
            userId: input.userId,
          })
          .onConflictDoUpdate({
            target: [VOTE.organizationId, VOTE.pollId, VOTE.userId],
            set: { optionId: option.id, updatedAt: sql`now()` },
            setWhere: sql`${VOTE.optionId} <> excluded.option_id`,
          })
          .returning({ id: VOTE.id });
        if (changed.length > 0) await hint(tx, orgId, input);
        return { poll: await viewOf(tx, orgId, input) };
      });
    },

    async closePoll(orgId, input) {
      await assertMember(orgId, input.userId, input.channelId);
      return withOrgContext(db, { organizationId: orgId, userId: input.userId }, async (tx) => {
        const poll = await lockedPoll(tx, orgId, input, "update");
        if (poll.createdByUserId !== input.userId && !input.canManage) {
          throw new ForbiddenError("only the poll's author or a channel manager may close it");
        }
        if (!poll.closedAt) {
          await tx
            .update(POLL)
            .set({ closedAt: sql`now()`, closedByUserId: input.userId })
            .where(and(eq(POLL.organizationId, orgId), eq(POLL.id, poll.id)));
          await hint(tx, orgId, input);
        }
        return { poll: await viewOf(tx, orgId, input) };
      });
    },
  };
}
