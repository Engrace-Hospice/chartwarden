// The composer's @-mention state in one place: the active query, its suggestions (members first, then people outside the
// conversation, WP 2.3), the pending "add to conversation?" choice, and choosing a suggestion into the draft.
import { useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { insertMention } from "./mention-utils";
import type {
  MentionCandidate,
  MentionOption,
  MessageReferenceInput,
  NonMemberOption,
} from "./messaging-types";
import { useMentionCandidates } from "./use-mention-candidates";

interface PendingAdd {
  readonly person: NonMemberOption;
  readonly query: { readonly query: string; readonly start: number };
  readonly stage: "ask" | "added";
}

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
  const client = useApiClient();
  const [query, setQuery] = useState<{ query: string; start: number } | null>(null);
  // Someone picked from outside the conversation: the add prompt replaces the suggestions until resolved. It keeps the
  // query it was picked from, so the result of the add never depends on what the live query is by then.
  const [pendingAdd, setPendingAdd] = useState<PendingAdd | null>(null);
  const [adding, setAdding] = useState(false);
  const [addFailed, setAddFailed] = useState(false);
  // The add is async and the user keeps typing: the late result reads the draft as it is NOW, never a stale closure.
  const latest = useRef({ draft, draftReferences });
  latest.current = { draft, draftReferences };
  const addingRef = useRef(false);
  const generation = useRef(0);
  const suggestions = useMentionCandidates({ channelId, meId, query });

  function insertChosen(
    candidate: MentionCandidate,
    at: { query: string; start: number },
    cursor: number,
  ): void {
    const { draft: currentDraft, draftReferences: currentReferences } = latest.current;
    const textarea = textareaRef.current;
    const chosen = insertMention({
      draft: currentDraft,
      references: currentReferences,
      query: at,
      cursor,
      candidate,
    });
    setDraft(chosen.draft);
    setDraftReferences(chosen.references);
    setQuery(null);
    window.requestAnimationFrame(() => {
      // A late add must not pull focus from where the user went meanwhile; the composer or nowhere (body) is fair game.
      const active = document.activeElement;
      if (active && active !== document.body && active !== textarea) return;
      textarea?.focus();
      textarea?.setSelectionRange(chosen.caret, chosen.caret);
    });
  }

  function choose(candidate: MentionOption): void {
    if (!query) return;
    if (candidate.kind === "not_member") {
      setAddFailed(false);
      setPendingAdd({ person: candidate, query, stage: "ask" });
      return;
    }
    insertChosen(candidate, query, textareaRef.current?.selectionStart ?? draft.length);
  }

  /** Add the pending person; when it lands, the `@name` it was picked from becomes a real mention if it is still there. */
  async function addToConversation(): Promise<void> {
    const pending = pendingAdd;
    if (!pending || addingRef.current) return;
    addingRef.current = true;
    const startedIn = generation.current;
    setAdding(true);
    setAddFailed(false);
    let ok = false;
    try {
      const { error } = await client.POST("/api/v1/messaging/channels/{id}/members", {
        params: { path: { id: channelId } },
        body: { userId: pending.person.entityId },
      });
      ok = !error;
    } catch {
      ok = false;
    }
    if (startedIn !== generation.current) return; // another conversation: nothing here to update
    addingRef.current = false;
    setAdding(false);
    if (!ok) {
      setAddFailed(true);
      return;
    }
    const { start, query: text } = pending.query;
    const end = start + 1 + text.length;
    if (latest.current.draft.slice(start, end) === `@${text}`) {
      setPendingAdd(null);
      insertChosen({ ...pending.person, kind: "staff" }, pending.query, end);
      return;
    }
    // The text it was picked from is gone: they are a member now, but there is nothing to turn into a mention. Say so.
    setPendingAdd({ ...pending, stage: "added" });
  }

  const dismissMentionAdd = useCallback(() => {
    if (!addingRef.current) setPendingAdd(null);
  }, []);
  const resetMention = useCallback(() => {
    generation.current += 1;
    addingRef.current = false;
    setAdding(false);
    setAddFailed(false);
    setQuery(null);
    setPendingAdd(null);
  }, []);
  // An emptied composer (a send, or cleared) has nothing left to mention into.
  useEffect(() => {
    if (draft === "" && !addingRef.current) setPendingAdd(null);
  }, [draft]);

  const { candidates, loading, error, activeIndex, retry } = suggestions;
  return {
    query,
    setQuery,
    pendingAdd,
    adding,
    addFailed,
    addToConversation,
    choose,
    dismissMentionAdd,
    resetMention,
    canAdd: suggestions.canAdd,
    setActiveIndex: suggestions.setActiveIndex,
    /** Props for `MentionMenu`. */
    menu: { loading, error, candidates, activeIndex, onChoose: choose, onRetry: retry },
  };
}
