// WP 2.4 - the closed palette of message reactions and the pin cap. Reactions are NON-CLINICAL social signals:
// none of these keys means "seen", "read" or "signed off", and the palette deliberately has no tick, thumbs-up or
// eyes glyph that a reader could mistake for one. The key (not the glyph) is what is stored, so a change of artwork
// never touches data; the web maps key -> glyph + accessible name. Widening the palette needs a migration
// (`message_reaction_emoji_check`).
export const MESSAGE_REACTION_KEYS = [
  "heart",
  "thanks",
  "smile",
  "celebrate",
  "sad",
  "hug",
] as const;
export type MessageReactionKey = (typeof MESSAGE_REACTION_KEYS)[number];

export function isMessageReactionKey(value: unknown): value is MessageReactionKey {
  return typeof value === "string" && (MESSAGE_REACTION_KEYS as readonly string[]).includes(value);
}

/** Pinned messages per channel. Bounds the pin list read; the 21st pin is a 409 `PIN_LIMIT_REACHED`. */
export const MAX_PINS_PER_CHANNEL = 20;

/** A reaction as a reader sees it: who reacted is never listed, only how many and whether the viewer did. */
export interface MessageReactionSummary {
  readonly emoji: MessageReactionKey;
  readonly count: number;
  readonly reactedByMe: boolean;
}
