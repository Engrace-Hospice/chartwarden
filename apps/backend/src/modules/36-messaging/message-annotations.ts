// apps/backend/src/modules/36-messaging/message-annotations.ts - WP 2.4: what a reader sees ON a message besides its
// text: the non-clinical reaction counts and the pin flag. One grouped read per page (no N+1), used by every message
// read through `hydrateMessages`. Counts only: who reacted is never listed. Reactions never feed receipt state.
import { schema } from "@chartwarden/db";
import { MESSAGE_REACTION_KEYS, type MessageReactionSummary } from "@chartwarden/types";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "./messaging-write-core";

const MRX = schema.messageReactions;
const MPIN = schema.messagePins;

export interface MessageAnnotations {
  readonly reactions: ReadonlyMap<string, readonly MessageReactionSummary[]>;
  readonly pinned: ReadonlySet<string>;
}

/** Palette order, so the chips never reshuffle between reads. */
function paletteRank(emoji: string): number {
  return (MESSAGE_REACTION_KEYS as readonly string[]).indexOf(emoji);
}

export async function loadReactionSummaries(
  tx: Tx,
  input: {
    orgId: string;
    channelId: string;
    viewerUserId: string;
    messageIds: readonly string[];
  },
): Promise<Map<string, MessageReactionSummary[]>> {
  const out = new Map<string, MessageReactionSummary[]>();
  if (input.messageIds.length === 0) return out;
  const rows = (await tx
    .select({
      messageId: MRX.messageId,
      emoji: MRX.emoji,
      count: sql<number>`count(*)::int`,
      reactedByMe: sql<boolean>`bool_or(${MRX.userId} = ${input.viewerUserId}::uuid)`,
    })
    .from(MRX)
    .where(
      and(
        eq(MRX.organizationId, input.orgId),
        eq(MRX.channelId, input.channelId),
        inArray(MRX.messageId, [...input.messageIds]),
      ),
    )
    .groupBy(MRX.messageId, MRX.emoji)) as Array<{
    messageId: string;
    emoji: string;
    count: number;
    reactedByMe: boolean;
  }>;
  for (const row of rows.sort((a, b) => paletteRank(a.emoji) - paletteRank(b.emoji))) {
    const list = out.get(row.messageId) ?? [];
    list.push({
      emoji: row.emoji as MessageReactionSummary["emoji"],
      count: Number(row.count),
      reactedByMe: row.reactedByMe === true,
    });
    out.set(row.messageId, list);
  }
  return out;
}

export async function loadMessageAnnotations(
  tx: Tx,
  input: {
    orgId: string;
    channelId: string;
    viewerUserId: string;
    messageIds: readonly string[];
  },
): Promise<MessageAnnotations> {
  if (input.messageIds.length === 0) return { reactions: new Map(), pinned: new Set() };
  const reactions = await loadReactionSummaries(tx, input);
  const pinRows = await tx
    .select({ messageId: MPIN.messageId })
    .from(MPIN)
    .where(
      and(
        eq(MPIN.organizationId, input.orgId),
        eq(MPIN.channelId, input.channelId),
        inArray(MPIN.messageId, [...input.messageIds]),
      ),
    );
  return { reactions, pinned: new Set(pinRows.map((r) => r.messageId)) };
}
