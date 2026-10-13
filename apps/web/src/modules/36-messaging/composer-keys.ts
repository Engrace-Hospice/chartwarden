// The composer textarea's keydown handling (moved out of ConversationThread unchanged in WP 2.11 to keep that file
// under the line ceiling). The thread passes the live state it reads; nothing here owns state.
import type { KeyboardEvent } from "react";
import { applyTextEdit, formatShortcutMarker, toggleWrap } from "./composer-format";
import { escapeKeepsMine } from "./draft-conflict-prompt";
import type { useMentionPicker } from "./use-mention-picker";
import type { ServerDraftSync } from "./use-server-draft";

type MentionPicker = ReturnType<typeof useMentionPicker>;

export interface ComposerKeyContext {
  /** An IME composition is in progress (composingRef.current at the time of the key). */
  composing: boolean;
  isMac: boolean;
  serverDraft: ServerDraftSync;
  draft: string;
  pendingAdd: MentionPicker["pendingAdd"];
  mentionQuery: MentionPicker["query"];
  mentionMenu: MentionPicker["menu"];
  dismissMentionAdd: MentionPicker["dismissMentionAdd"];
  setMentionQuery: MentionPicker["setQuery"];
  setMentionIndex: MentionPicker["setActiveIndex"];
  chooseMention: MentionPicker["choose"];
  send: () => Promise<void>;
}

export function handleComposerKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  ctx: ComposerKeyContext,
): void {
  const {
    composing,
    isMac,
    serverDraft,
    draft,
    pendingAdd,
    mentionQuery,
    mentionMenu,
    dismissMentionAdd,
    setMentionQuery,
    setMentionIndex,
    chooseMention,
    send,
  } = ctx;
  // While an IME is composing, every key belongs to the IME (candidate selection, cancel): handle none of ours.
  if (composing || event.nativeEvent.isComposing) return;
  if (escapeKeepsMine(event, serverDraft)) return;
  const marker = formatShortcutMarker(event, isMac);
  if (marker) {
    // The edit runs through the textarea's own input path (undo stack, onChange, mention query recompute).
    event.preventDefault();
    const area = event.currentTarget;
    // Built from the live value: React state may lag a programmatic change (autofill, an extension).
    applyTextEdit(area, toggleWrap(area.value, area.selectionStart, area.selectionEnd, marker));
    return;
  }
  if (pendingAdd && event.key === "Escape") {
    // Escape closes the add prompt (unless the add is in flight) and the suggestions with it.
    event.preventDefault();
    dismissMentionAdd();
    setMentionQuery(null);
    return;
  }
  if (mentionQuery && event.key === "Escape") {
    event.preventDefault();
    setMentionQuery(null);
    return;
  }
  // While the add prompt is open the (hidden) suggestions own no keys: Tab reaches the prompt's buttons, Enter sends.
  if (mentionQuery && !pendingAdd && mentionMenu.candidates.length > 0) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setMentionIndex((index) =>
        event.key === "ArrowDown"
          ? (index + 1) % mentionMenu.candidates.length
          : (index - 1 + mentionMenu.candidates.length) % mentionMenu.candidates.length,
      );
      return;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      event.preventDefault();
      chooseMention(mentionMenu.candidates[mentionMenu.activeIndex]!);
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void send();
    return;
  }
  // Escape in an EMPTY composer hands focus back to the page; with a draft it does nothing (the draft is never
  // lost to a stray key). Tab is never intercepted outside the mention popup, so there is no keyboard trap.
  if (event.key === "Escape" && draft === "") event.currentTarget.blur();
}
