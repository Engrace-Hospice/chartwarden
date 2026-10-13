// apps/backend/src/modules/36-messaging/message-hint-events.ts — ADR-0054 addendum A4: the transactional outbox
// events that drive realtime "something changed" hints. PHI-free by construction: ids and timestamps only, never a
// body, preview, name or patient identifier. Published in the SAME transaction as the message write, so a hint can
// never announce a write that rolled back, and a committed write always has its hint.

/** Structural subset of `MessagingOutboxPort` (messaging-route-service-db.ts) - declared here to avoid an import cycle. */
export interface HintOutboxPort {
  publish(
    tx: unknown,
    emission: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

export const M36_MESSAGE_HINT_EVENTS = {
  sent: "m36.message.sent",
  edited: "m36.message.edited",
  deleted: "m36.message.deleted",
} as const;

export type MessageHintKind = keyof typeof M36_MESSAGE_HINT_EVENTS;

export async function publishMessageHint(
  outbox: HintOutboxPort | undefined,
  tx: unknown,
  kind: MessageHintKind,
  facts: {
    readonly orgId: string;
    readonly channelId: string;
    readonly messageId: string;
    /** WP 2.2: set when the message is a thread reply, so a client can refresh that thread (an id, never content). */
    readonly parentMessageId?: string | null;
    /** `sent`: the message's created_at. `edited`/`deleted`: when the change was committed. */
    readonly at: Date | string;
  },
): Promise<void> {
  await outbox?.publish(tx, {
    eventName: M36_MESSAGE_HINT_EVENTS[kind],
    organizationId: facts.orgId,
    aggregateKind: "message",
    aggregateId: facts.messageId,
    payload: {
      organizationId: facts.orgId,
      channelId: facts.channelId,
      messageId: facts.messageId,
      ...(facts.parentMessageId ? { parentMessageId: facts.parentMessageId } : {}),
      at: typeof facts.at === "string" ? facts.at : facts.at.toISOString(),
    },
  });
}
