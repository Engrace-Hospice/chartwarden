// WP 2.4: how the closed reaction palette (packages/types messaging-reactions.ts) looks and is announced. The server
// stores the KEY; the glyph is artwork only (aria-hidden), the label is what a screen reader hears.
import { MESSAGE_REACTION_KEYS, type MessageReactionKey } from "@chartwarden/types";

export interface ReactionPaletteEntry {
  readonly key: MessageReactionKey;
  readonly glyph: string;
  readonly label: string;
}

const LOOK: Record<MessageReactionKey, { glyph: string; label: string }> = {
  heart: { glyph: "❤️", label: "Heart" },
  thanks: { glyph: "\u{1F64F}", label: "Thanks" },
  smile: { glyph: "\u{1F642}", label: "Smile" },
  celebrate: { glyph: "\u{1F389}", label: "Celebrate" },
  sad: { glyph: "\u{1F622}", label: "Sad" },
  hug: { glyph: "\u{1F917}", label: "Hug" },
};

export const REACTION_PALETTE: readonly ReactionPaletteEntry[] = MESSAGE_REACTION_KEYS.map(
  (key) => ({ key, ...LOOK[key] }),
);

export function paletteEntry(key: string): ReactionPaletteEntry | undefined {
  return REACTION_PALETTE.find((entry) => entry.key === key);
}

/**
 * The one sentence every reaction control carries: a reaction is NOT a sign-off. Sign-off is its own
 * control (a different component, never the reaction picker), so nothing here can be mistaken for it.
 */
export const REACTION_NOT_ACK_COPY =
  "A reaction is a friendly response. It does not mean anyone has read, acknowledged or acted on this message.";
