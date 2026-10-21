// WP 2.4 - the in-memory twin of the `message_reaction` / `message_pin` tables. Pure state: the service does the access
// checks (channel scoping, live message, archive) exactly as the DB service does and then calls into this.
import {
  MAX_PINS_PER_CHANNEL,
  MESSAGE_REACTION_KEYS,
  type MessageReactionKey,
  type MessageReactionSummary,
} from "@chartwarden/types";

export interface ReactionPinState {
  setReaction(messageId: string, emoji: MessageReactionKey, userId: string, present: boolean): void;
  /** Palette order, empty emojis omitted - the same shape the DB read returns. */
  summary(messageId: string, viewerUserId: string): MessageReactionSummary[];
  isPinned(channelId: string, messageId: string): boolean;
  /** Returns the pin time; `capReached` instead when a NEW pin would exceed the channel cap. */
  pin(channelId: string, messageId: string, at: string): { pinnedAt: string } | "capReached";
  unpin(channelId: string, messageId: string): void;
  /** Most recently pinned first. */
  pinned(channelId: string): { messageId: string; pinnedAt: string }[];
}

export function createReactionPinState(): ReactionPinState {
  const reactions = new Map<string, Map<MessageReactionKey, Set<string>>>();
  const pins = new Map<string, Map<string, string>>();
  return {
    setReaction(messageId, emoji, userId, present) {
      const byEmoji = reactions.get(messageId) ?? new Map<MessageReactionKey, Set<string>>();
      const users = byEmoji.get(emoji) ?? new Set<string>();
      if (present) users.add(userId);
      else users.delete(userId);
      byEmoji.set(emoji, users);
      reactions.set(messageId, byEmoji);
    },
    summary(messageId, viewerUserId) {
      const byEmoji = reactions.get(messageId);
      if (!byEmoji) return [];
      return MESSAGE_REACTION_KEYS.flatMap((emoji) => {
        const users = byEmoji.get(emoji);
        return users && users.size > 0
          ? [{ emoji, count: users.size, reactedByMe: users.has(viewerUserId) }]
          : [];
      });
    },
    isPinned: (channelId, messageId) => pins.get(channelId)?.has(messageId) ?? false,
    pin(channelId, messageId, at) {
      const forChannel = pins.get(channelId) ?? new Map<string, string>();
      const existing = forChannel.get(messageId);
      if (existing) return { pinnedAt: existing };
      if (forChannel.size >= MAX_PINS_PER_CHANNEL) return "capReached";
      forChannel.set(messageId, at);
      pins.set(channelId, forChannel);
      return { pinnedAt: at };
    },
    unpin(channelId, messageId) {
      pins.get(channelId)?.delete(messageId);
    },
    pinned(channelId) {
      return [...(pins.get(channelId) ?? [])]
        .map(([messageId, pinnedAt]) => ({ messageId, pinnedAt }))
        .sort(
          (a, b) => b.pinnedAt.localeCompare(a.pinnedAt) || b.messageId.localeCompare(a.messageId),
        );
    },
  };
}
