// apps/backend/src/modules/36-messaging/polls/poll-views.ts - WP 2.10: what a reader sees of a poll. One grouped read
// per page of messages (no N+1), used by `hydrateMessages` for every message read, and by the poll service for the
// answer to a vote / close. Counts and the viewer's own vote only; who voted is the poll detail read.
import { schema } from "@wardenx/db";
import type { PollOptionView, PollView, PollVoterView } from "@wardenx/types";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { MessageBodyCipher, Tx } from "../messaging-write-core";

const POLL = schema.messagePolls;
const OPT = schema.messagePollOptions;
const VOTE = schema.messagePollVotes;
const USER = schema.users;

export interface PollViewInput {
  readonly orgId: string;
  readonly channelId: string;
  readonly viewerUserId: string;
  readonly messageIds: readonly string[];
  readonly cipher: MessageBodyCipher;
}

/** The polls on these messages, keyed by message id. A message without a poll is simply absent. */
export async function loadPollViews(tx: Tx, input: PollViewInput): Promise<Map<string, PollView>> {
  const out = new Map<string, PollView>();
  if (input.messageIds.length === 0) return out;
  const polls = await tx
    .select({
      id: POLL.id,
      messageId: POLL.messageId,
      createdByUserId: POLL.createdByUserId,
      closedAt: POLL.closedAt,
    })
    .from(POLL)
    .where(
      and(
        eq(POLL.organizationId, input.orgId),
        eq(POLL.channelId, input.channelId),
        inArray(POLL.messageId, [...input.messageIds]),
      ),
    );
  if (polls.length === 0) return out;
  const pollIds = polls.map((p) => p.id);
  const options = await tx
    .select({ id: OPT.id, pollId: OPT.pollId, labelCipher: OPT.labelCipher })
    .from(OPT)
    .where(and(eq(OPT.organizationId, input.orgId), inArray(OPT.pollId, pollIds)))
    .orderBy(asc(OPT.pollId), asc(OPT.position));
  const counts = await tx
    .select({
      optionId: VOTE.optionId,
      n: sql<number>`count(*)::int`,
      mine: sql<boolean>`bool_or(${VOTE.userId} = ${input.viewerUserId}::uuid)`,
    })
    .from(VOTE)
    .where(and(eq(VOTE.organizationId, input.orgId), inArray(VOTE.pollId, pollIds)))
    .groupBy(VOTE.optionId);
  const countByOption = new Map(counts.map((c) => [c.optionId, Number(c.n)]));
  const myOption = new Set(counts.filter((c) => c.mine === true).map((c) => c.optionId));
  const labels = new Map<string, string>();
  for (const option of options) {
    labels.set(option.id, await input.cipher.open(input.orgId, option.labelCipher));
  }
  for (const poll of polls) {
    const views: PollOptionView[] = options
      .filter((o) => o.pollId === poll.id)
      .map((o) => ({
        optionId: o.id,
        label: labels.get(o.id) ?? "",
        voteCount: countByOption.get(o.id) ?? 0,
      }));
    out.set(poll.messageId, {
      pollId: poll.id,
      closed: poll.closedAt !== null,
      closedAt: poll.closedAt?.toISOString() ?? null,
      totalVotes: views.reduce((sum, o) => sum + o.voteCount, 0),
      myOptionId: views.find((o) => myOption.has(o.optionId))?.optionId ?? null,
      canClose: poll.closedAt === null && poll.createdByUserId === input.viewerUserId,
      options: views,
    });
  }
  return out;
}

/** Who voted for what, named, grouped by option id. Ordered by when the vote was last cast. */
export async function loadPollVoters(
  tx: Tx,
  input: { orgId: string; pollId: string },
): Promise<Record<string, PollVoterView[]>> {
  const rows = await tx
    .select({
      optionId: VOTE.optionId,
      userId: VOTE.userId,
      displayName: USER.name,
      votedAt: VOTE.updatedAt,
    })
    .from(VOTE)
    .leftJoin(USER, eq(USER.id, VOTE.userId))
    .where(and(eq(VOTE.organizationId, input.orgId), eq(VOTE.pollId, input.pollId)))
    .orderBy(asc(VOTE.updatedAt), asc(VOTE.id));
  const voters: Record<string, PollVoterView[]> = {};
  for (const row of rows) {
    const list = voters[row.optionId] ?? [];
    list.push({
      userId: row.userId,
      displayName: row.displayName?.trim() || "Staff member",
      votedAt: row.votedAt.toISOString(),
    });
    voters[row.optionId] = list;
  }
  return voters;
}
