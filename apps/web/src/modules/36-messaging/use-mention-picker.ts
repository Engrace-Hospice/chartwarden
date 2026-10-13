// The composer's @-mention state in one place: the active query, its suggestions (members first, then people outside the
// conversation, WP 2.3), the pending "add to conversation?" choice, and choosing a suggestion into the draft.
import { useCallback, useState } from "react";
import type { RefObject } from "react";
import { insertMention } from "./mention-utils";
import type { MentionOption, MessageReferenceInput, NonMemberOption } from "./messaging-types";
import { useMentionCandidates } from "./use-mention-candidates";

export function useMentionPicker(input: {
  readonly channelId: string;
  readonly meId: string;
  readonly draft: string;
  readonly draftReferences: readonly MessageReferenceInput[];
  readonly setDraft: (draft: string) => void;
  readonly setDraftReferences: (references: MessageReferenceInput[]) => void;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const { channelId, meId, draft, draftReferences, setDraft, setDraftReferences, textareaRef } =
    input;
  const [query, setQuery] = useState<{ query: string; start: number } | null>(null);
  // Someone picked from outside the conversation: the add prompt replaces the suggestions until resolved.
  const [pendingAdd, setPendingAdd] = useState<NonMemberOption | null>(null);
  const suggestions = useMentionCandidates({ channelId, meId, query });

  function choose(candidate: MentionOption): void {
    if (!query) return;
    if (candidate.kind === "not_member") {
      setPendingAdd(candidate);
      return;
    }
    const textarea = textareaRef.current;
    const chosen = insertMention({
      draft,
      references: draftReferences,
      query,
      cursor: textarea?.selectionStart ?? draft.length,
      candidate,
    });
    setDraft(chosen.draft);
    setDraftReferences(chosen.references);
    setQuery(null);
    window.requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(chosen.caret, chosen.caret);
    });
  }

  /** The person was added to the conversation: they are a member now, so the pending `@name` becomes a mention. */
  function mentionAdded(person: NonMemberOption): void {
    setPendingAdd(null);
    choose({ ...person, kind: "staff" });
  }
  const dismissMentionAdd = useCallback(() => setPendingAdd(null), []);
  const resetMention = useCallback(() => {
    setQuery(null);
    setPendingAdd(null);
  }, []);

  const { candidates, loading, error, activeIndex, retry } = suggestions;
  return {
    query,
    setQuery,
    pendingAdd,
    choose,
    mentionAdded,
    dismissMentionAdd,
    resetMention,
    canAdd: suggestions.canAdd,
    setActiveIndex: suggestions.setActiveIndex,
    /** Props for `MentionMenu`. */
    menu: { loading, error, candidates, activeIndex, onChoose: choose, onRetry: retry },
  };
}
