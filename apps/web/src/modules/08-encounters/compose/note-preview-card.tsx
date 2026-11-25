// apps/web/src/modules/08-encounters/compose — the composer's "Note as it reads" card: the server-assembled note (or the author's edit of
// it), a stale-edit warning, the edit box, and the edit / save actions (moved out of encounter-compose.tsx unchanged).
import { Button, TextAreaField } from "@chartwarden/ui";
import type { JSX } from "react";
import {
  eyebrow,
  previewActions,
  previewBody,
  previewCard,
  previewEmpty,
  previewEmptyText,
  previewEmptyTitle,
  previewFooter,
  previewFooterText,
  previewHeader,
  previewStatus,
  previewText,
  previewTitle,
  staleEditNotice,
} from "../encounter-compose-styles";

export interface NotePreviewCardProps {
  /** The author is typing over the note text. */
  readonly editing: boolean;
  /** The saved edit is the note as it reads (an edit that went stale is not). */
  readonly editInForce: boolean;
  /** The saved edit of the note text; null when the note reads as generated. */
  readonly editedNarrative: string | null;
  /** The note moved underneath the saved edit since it was made. */
  readonly editStale: boolean;
  /** The generated text, as the server last assembled it. */
  readonly preview: string;
  /** The note as it reads now: the edit when it is in force, else the generated text. */
  readonly noteText: string;
  readonly editText: string;
  readonly onEditTextChange: (value: string) => void;
  readonly editable: boolean;
  readonly busy: boolean;
  readonly onCancelEdit: () => void;
  readonly onDiscardEdit: () => void;
  readonly onApplyEdit: () => void;
  readonly onStartEdit: () => void;
  readonly onSave: () => void;
}

function previewStatusWords({
  editing,
  editInForce,
  editedNarrative,
  preview,
}: Pick<NotePreviewCardProps, "editing" | "editInForce" | "editedNarrative" | "preview">): string {
  return editing
    ? "Editing"
    : editInForce
      ? "Edited by you"
      : editedNarrative !== null
        ? "Edit out of date"
        : preview.trim().length > 0
          ? "Available"
          : "Not saved";
}

function previewFooterWords({
  editing,
  editInForce,
  editedNarrative,
}: Pick<NotePreviewCardProps, "editing" | "editInForce" | "editedNarrative">): string {
  return editing
    ? "Your text is what will be signed; the generated text is kept beside it."
    : editInForce
      ? "Your edited text will be signed."
      : editedNarrative !== null
        ? "Apply a new edit or discard the old one to finalize."
        : "Preview updates after saving.";
}

function PreviewBody({
  editing,
  noteText,
  editText,
  onEditTextChange,
  busy,
}: Pick<
  NotePreviewCardProps,
  "editing" | "noteText" | "editText" | "onEditTextChange" | "busy"
>): JSX.Element {
  return (
    <div style={previewBody}>
      {editing ? (
        <TextAreaField
          label="Note text"
          value={editText}
          onChange={(e) => onEditTextChange(e.target.value)}
          rows={14}
          disabled={busy}
        />
      ) : noteText.trim().length === 0 ? (
        <div style={previewEmpty}>
          <strong style={previewEmptyTitle}>No assembled narrative yet</strong>
          <p style={previewEmptyText}>
            Save the draft to generate the server-built narrative from your selections.
          </p>
        </div>
      ) : (
        <p style={previewText}>{noteText}</p>
      )}
    </div>
  );
}

function PreviewFooter({
  editing,
  editInForce,
  editedNarrative,
  editText,
  busy,
  onCancelEdit,
  onDiscardEdit,
  onApplyEdit,
  onStartEdit,
  onSave,
}: Omit<
  NotePreviewCardProps,
  "preview" | "editStale" | "noteText" | "onEditTextChange" | "editable"
>): JSX.Element {
  return (
    <footer style={previewFooter}>
      <span style={previewFooterText}>
        {previewFooterWords({ editing, editInForce, editedNarrative })}
      </span>
      <span style={previewActions}>
        {editing ? (
          <>
            <Button tone="tertiary" onClick={onCancelEdit} disabled={busy}>
              Cancel
            </Button>
            {editedNarrative !== null ? (
              <Button tone="tertiary" onClick={onDiscardEdit} disabled={busy}>
                Discard edit
              </Button>
            ) : null}
            <Button onClick={onApplyEdit} disabled={busy || editText.trim().length === 0}>
              {busy ? "Saving…" : "Apply edit"}
            </Button>
          </>
        ) : (
          <>
            {editedNarrative !== null ? (
              <Button tone="tertiary" onClick={onDiscardEdit} disabled={busy}>
                Discard edit
              </Button>
            ) : null}
            <Button tone="tertiary" onClick={onStartEdit} disabled={busy}>
              Edit
            </Button>
            <Button tone="tertiary" onClick={onSave} disabled={busy}>
              {busy ? "Saving…" : "Save & refresh preview"}
            </Button>
          </>
        )}
      </span>
    </footer>
  );
}

export function NotePreviewCard(props: NotePreviewCardProps): JSX.Element {
  const { editing, editedNarrative, editStale, editable } = props;
  return (
    <section style={previewCard}>
      <header style={previewHeader}>
        <div>
          <div style={eyebrow}>SERVER-ASSEMBLED PREVIEW</div>
          <h2 style={previewTitle}>Note as it reads</h2>
        </div>

        <span style={previewStatus}>{previewStatusWords(props)}</span>
      </header>

      {editedNarrative !== null && editStale && !editing ? (
        <div role="alert" style={staleEditNotice}>
          <strong>The note changed after you edited this text.</strong> Below is the note as it now
          reads; your earlier edit is not used. Edit it again to keep your wording, or discard the
          old edit. The note cannot be finalized until you do.
          <details>
            <summary>Your earlier edit</summary>
            <p style={previewText}>{editedNarrative}</p>
          </details>
        </div>
      ) : null}

      <PreviewBody {...props} />

      {editable ? <PreviewFooter {...props} /> : null}
    </section>
  );
}
