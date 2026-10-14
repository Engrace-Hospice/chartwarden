// WP 2.5: the merge prompt shown when this draft was changed on another device since this one last saw it. Inline
// above the composer (not a modal: the user can still read the conversation), announced as an alert. It never takes
// focus from the composer the user is typing in (that would swallow the next keystrokes); it only moves focus to its
// first action when focus is somewhere else. Tab stays natural. Escape keeps the user's own text (never discards it)
// both from inside the prompt and from the composer while the prompt is showing (`escapeKeepsMine`).
import { useEffect, useId, useRef } from "react";
import { SBAR_URGENCY_LABEL, isBlankSbar } from "./sbar-utils";
import type {
  DraftConflict,
  DraftContent,
  DraftResolution,
  ServerDraftSync,
} from "./use-server-draft";
import "./draft-conflict.css";

const PREVIEW_LENGTH = 240;

function preview(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH)}…` : flat;
}

const SBAR_SITUATION_PREVIEW_LENGTH = 60;

/** One plain-text line per side so two SBAR versions can be told apart: urgency, then the start of Situation. */
function sbarSummary(sbar: DraftContent["sbar"]): string {
  if (!sbar) return "";
  const parts = ["SBAR", SBAR_URGENCY_LABEL[sbar.urgencyHint]];
  const situation = (sbar.sections.situation ?? "").replace(/\s+/g, " ").trim();
  if (situation)
    parts.push(
      situation.length > SBAR_SITUATION_PREVIEW_LENGTH
        ? `${situation.slice(0, SBAR_SITUATION_PREVIEW_LENGTH)}…`
        : situation,
    );
  return parts.join(" · ");
}

function sideSummary(content: DraftContent): string {
  return [preview(content.body), sbarSummary(content.sbar)].filter(Boolean).join(" · ");
}

/** True when the user is typing in a text field (or an editable region) right now. */
function isTyping(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return (
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLInputElement ||
    element.isContentEditable
  );
}

/** Escape in the composer while the merge prompt is open keeps the user's text and closes the prompt. */
export function escapeKeepsMine(
  event: { key: string; preventDefault: () => void },
  sync: Pick<ServerDraftSync, "conflict" | "resolve">,
): boolean {
  if (event.key !== "Escape" || !sync.conflict) return false;
  event.preventDefault();
  sync.resolve("mine");
  return true;
}

export interface DraftConflictPromptProps {
  conflict: DraftConflict;
  onResolve: (choice: DraftResolution) => void;
}

export function DraftConflictPrompt({
  conflict,
  onResolve,
}: DraftConflictPromptProps): JSX.Element {
  const firstActionRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<Element | null>(null);
  const movedFocus = useRef(false);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    if (isTyping(previouslyFocused.current)) return;
    movedFocus.current = true;
    firstActionRef.current?.focus();
    return () => {
      const target = previouslyFocused.current;
      if (movedFocus.current && target instanceof HTMLElement && target.isConnected) target.focus();
    };
  }, []);

  return (
    <div
      role="alert"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className="wx-draft-conflict"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onResolve("mine");
      }}
    >
      <p id={titleId} className="wx-draft-conflict-title">
        This draft changed on another device
      </p>
      <div id={bodyId} className="wx-draft-conflict-body">
        <p>
          <span>Here: </span>
          {sideSummary(conflict.mine)}
        </p>
        <p>
          <span>Other device: </span>
          {sideSummary(conflict.server)}
        </p>
        {conflict.mine.sbar || conflict.server.sbar ? (
          <p>
            Combine both keeps the SBAR form from here when it has content, otherwise the other
            device's.
          </p>
        ) : null}
      </div>
      <div className="wx-draft-conflict-actions">
        <button ref={firstActionRef} type="button" onClick={() => onResolve("mine")}>
          Keep mine
        </button>
        <button type="button" onClick={() => onResolve("theirs")}>
          Use theirs
        </button>
        <button type="button" onClick={() => onResolve("both")}>
          Combine both
        </button>
      </div>
    </div>
  );
}

/** The merge prompt (when another device changed this draft) and a quiet status line when autosave is failing. */
export function DraftSyncNotice({ sync }: { sync: ServerDraftSync }): JSX.Element | null {
  if (sync.conflict)
    return <DraftConflictPrompt conflict={sync.conflict} onResolve={sync.resolve} />;
  if (!sync.saveFailed) return null;
  return (
    <output className="wx-draft-status">
      {sync.saveGaveUp
        ? "Could not save this draft. It is kept on this device only, and saving restarts when you type."
        : "Draft not saved yet. Your text is kept here; we are retrying."}
    </output>
  );
}
