// apps/web/src/modules/08-encounters — the note view when the server could not decide what this viewer may read of the signed note
// (503 NOTE_VIEW_UNAVAILABLE: its 42 CFR Part 2 disclosure check failed; S1 PR E1, ADR-0114). It is a failure to retry, never a denial and
// never an empty or partial note: the whole read is refused, so the screen shows this in place of the note, announced, with the retry.
import { ErrorState } from "@chartwarden/ui";
import type { JSX } from "react";

/** The refusal of an encounter read whose Part 2 disclosure check could not be decided. */
export const NOTE_VIEW_UNAVAILABLE_CODE = "NOTE_VIEW_UNAVAILABLE";

export const NOTE_VIEW_UNAVAILABLE_DESCRIPTION =
  "Your access to this note's 42 CFR Part 2 content could not be checked, so none of the note is shown. Nothing was changed. Try again in a moment.";

/** Whether `error` (an API error body) is the refusal for a note view that could not be decided. */
export function isNoteViewUnavailable(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const envelope = (error as { error?: unknown }).error;
  return (
    envelope !== null &&
    typeof envelope === "object" &&
    (envelope as { code?: unknown }).code === NOTE_VIEW_UNAVAILABLE_CODE
  );
}

export interface NoteViewUnavailableProps {
  /** What to tell the reader: the default sentence, or a more specific one the screen holds (a note finalized a moment ago). */
  readonly description: string;
  readonly onRetry: () => void;
}

export function NoteViewUnavailable({
  description,
  onRetry,
}: NoteViewUnavailableProps): JSX.Element {
  return (
    <ErrorState
      title="The note cannot be shown right now"
      description={description}
      onRetry={onRetry}
      retryLabel="Try again"
    />
  );
}
