// apps/backend/src/modules/08-encounters/routes/narrative-edit.ts — the author's edit of the note text (WF09).
//
// The Layer-1 narrative is a pure function of the selections, the vitals and the corpus, and stays that: it is always kept. An author
// may also edit the TEXT of a draft; that edit is stored beside the generated text, flagged, and is what gets signed. Because the
// generated text can move after an edit (a statement ticked, a vital recorded), an edit remembers the generated text it was made from:
// when that no longer matches, the edit is STALE and a note cannot be finalized on it until the author reviews it again.
//
// Pure, so the in-memory service the route tests run on and the Drizzle service apply the same rules.
import { createHash } from "node:crypto";
import { EncounterStateError } from "../lifecycle/errors";

/** The longest note text an author may save. Generous for a hospice visit note; bounded so one request cannot store a book. */
export const MAX_EDITED_NARRATIVE_LENGTH = 20_000;

/** An edit as stored: the author's text and a hash of the generated text it was made from. */
export interface NarrativeEdit {
  readonly text: string;
  readonly basisHash: string;
}

/** A fingerprint of a generated narrative (never the text itself, so it is safe beside the edit). */
export function narrativeHash(generated: string): string {
  return createHash("sha256").update(generated).digest("hex");
}

/** True when the generated text has moved since the edit was made. */
export function isStaleEdit(edit: NarrativeEdit | null, generated: string): boolean {
  return edit !== null && edit.basisHash !== narrativeHash(generated);
}

/**
 * What the note's edit becomes after a selections write; `generated` is the Layer-1 assembly AFTER that write.
 *
 *  - `requested` undefined: the edit is kept as it is (its basis too, so a change underneath it stays visible as stale).
 *  - null: the edit is discarded and the note reads as generated.
 *  - text: stored against the current generated text. Text identical to it is not an edit, and empty text is refused: discarding is
 *    the way back to the generated note.
 */
export function nextNarrativeEdit(args: {
  readonly requested: string | null | undefined;
  readonly current: NarrativeEdit | null;
  readonly generated: string;
}): NarrativeEdit | null {
  const { requested, current, generated } = args;
  if (requested === undefined) return current;
  if (requested === null) return null;
  const text = requested.trim();
  if (text.length === 0) {
    throw new EncounterStateError(
      "INVALID_NARRATIVE_EDIT",
      "the note text is empty; discard the edit to go back to the generated text",
    );
  }
  if (text === generated.trim()) return null;
  return { text, basisHash: narrativeHash(generated) };
}

/** The text a note is finalized with, and whether it is the author's edit. A stale edit refuses (409) rather than pin text that may be wrong. */
export function finalNarrative(
  generated: string,
  edit: NarrativeEdit | null,
): { readonly final: string; readonly clinicianEdited: boolean } {
  if (edit === null) return { final: generated, clinicianEdited: false };
  if (isStaleEdit(edit, generated)) {
    throw new EncounterStateError(
      "NARRATIVE_EDIT_STALE",
      "the selections or vitals changed after you edited the note text; review the text and apply it again, or discard your edit",
    );
  }
  return { final: edit.text, clinicianEdited: true };
}
