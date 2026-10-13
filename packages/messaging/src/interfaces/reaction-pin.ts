// WP 2.4 - reactions and pins, the part of `MessagingRouteService` that is not about posting or reading history.
// Both are channel-scoped: the caller has run `channel_visibility` on `channelId`, and every operation re-scopes the
// message to that channel, so a message of another channel, another org or an unknown id is the one 404 a random id gets.
// Reactions are non-clinical and are NOT a sign-off: nothing here reads or writes receipt state.
import type { MessageReactionKey, MessageReactionSummary } from "@wardenx/types";
import type { ResolvedMessage } from "./provider";

export interface MessageReactionPinService {
  /**
   * Add (`present: true`) or remove (`present: false`) the caller's reaction. Idempotent in both directions.
   * 404 for a message that is not a live message of the channel; 410 CHANNEL_ARCHIVED on an archived channel.
   * Returns the message's reaction summary after the change, from the caller's point of view.
   */
  setReaction(
    orgId: string,
    input: {
      userId: string;
      channelId: string;
      messageId: string;
      emoji: MessageReactionKey;
      present: boolean;
    },
  ): Promise<{ reactions: readonly MessageReactionSummary[] }>;
  /** Pin a live message of the channel. Idempotent; 409 PIN_LIMIT_REACHED at the per-channel cap; 410 if archived. */
  pinMessage(
    orgId: string,
    input: { userId: string; channelId: string; messageId: string },
  ): Promise<{ pinnedAt: string }>;
  /** Unpin. Idempotent (nothing pinned is a no-op, not a 404, so a retry or a race never errors); 410 if archived. */
  unpinMessage(
    orgId: string,
    input: { userId: string; channelId: string; messageId: string },
  ): Promise<void>;
  /** The channel's pinned live messages, most recently pinned first (at most MAX_PINS_PER_CHANNEL). */
  listPins(
    orgId: string,
    input: { userId: string; channelId: string },
  ): Promise<{
    pins: readonly ResolvedMessage[];
    /** The care_team channel's patient, for read-audit attribution (GAP-064); null for other kinds. */
    patientId: string | null;
  }>;
}
