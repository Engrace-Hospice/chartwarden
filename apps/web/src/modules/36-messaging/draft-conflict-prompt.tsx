// WP 2.5: the merge prompt shown when this draft was changed on another device since this one last saw it. Inline
// above the composer (not a modal: the user can still read the conversation), announced as an alert dialog, focus lands
// on the first action, Tab stays among the three actions, and Escape keeps the user's own text (never discards it).
import { useEffect, useRef } from "react";
import type { DraftConflict, DraftResolution, ServerDraftSync } from "./use-server-draft";
import "./draft-conflict.css";

const PREVIEW_LENGTH = 240;

function preview(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH)}…` : flat;
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

  useEffect(() => {
    previouslyFocused.current = document.activeElement;
    firstActionRef.current?.focus();
    return () => {
      const target = previouslyFocused.current;
      if (target instanceof HTMLElement && target.isConnected) target.focus();
    };
  }, []);

  return (
    <div
      role="alertdialog"
      aria-labelledby="wx-draft-conflict-title"
      aria-describedby="wx-draft-conflict-body"
      className="wx-draft-conflict"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.stopPropagation();
        onResolve("mine");
      }}
    >
      <p id="wx-draft-conflict-title" className="wx-draft-conflict-title">
        This draft changed on another device
      </p>
      <div id="wx-draft-conflict-body" className="wx-draft-conflict-body">
        <p>
          <span>Here: </span>
          {preview(conflict.mine.body)}
        </p>
        <p>
          <span>Other device: </span>
          {preview(conflict.server.body)}
        </p>
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
      Draft not saved yet. Your text is kept here; we will retry as you type.
    </output>
  );
}
