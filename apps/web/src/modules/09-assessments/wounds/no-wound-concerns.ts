// apps/web/src/modules/09-assessments/wounds — the clinician's "No skin or wound concerns at this visit" statement.
//
// It is ONE fixed sentence, added to the Skin and Wounds section's free text (which the server stores and states verbatim, so the note,
// its preview and the finalize gate need nothing new). Pressing the button is the clinician's own attestation, not a requirement: the
// section stays optional. Pure: this file only reads the text and cuts the sentence out again; the composer owns adding it.

export const NO_WOUND_CONCERNS_SENTENCE =
  "No skin breakdown or wounds were identified at this visit.";

/** What the panel hands the composer: add the sentence, or take exactly that sentence out again. */
export type NoWoundConcernsChange = "state" | "undo";

/**
 * What the section's free text says about it:
 * - `stated`: the exact sentence is in the text (the button added it, and it can be taken out exactly);
 * - `reworded`: the clinician edited it so it no longer matches but the note still says there is no skin breakdown or wound;
 * - `absent`: neither.
 */
export type NoWoundConcernsState = "absent" | "stated" | "reworded";

// ponytail: a phrase match, not language understanding. The clinician's own different words ("no wounds noted") are not caught;
// add a phrase here only when a real edit slips through.
const REWORDED_STEM = "no skin breakdown or wounds";

export function noWoundConcernsState(freeText: string): NoWoundConcernsState {
  if (freeText.includes(NO_WOUND_CONCERNS_SENTENCE)) return "stated";
  const plain = freeText.toLowerCase().replace(/\s+/g, " ");
  return plain.includes(REWORDED_STEM) ? "reworded" : "absent";
}

/** `text` with the sentence at `at` cut out, and with the single line break or space it was set apart by. */
function cutSentenceAt(text: string, at: number): string {
  const before = text.slice(0, at);
  const after = text.slice(at + NO_WOUND_CONCERNS_SENTENCE.length);
  const atLineStart = before === "" || before.endsWith("\n");
  if (atLineStart && (after.startsWith("\n") || after.startsWith(" "))) {
    return `${before}${after.slice(1)}`;
  }
  if (after === "" && before.endsWith("\n")) return before.slice(0, -1);
  if (before.endsWith(" ") && after.startsWith(" ")) return `${before}${after.slice(1)}`;
  return `${before}${after}`;
}

/** The text without the exact sentence (every copy of it); anything else the clinician wrote is left as typed. */
export function withoutNoWoundConcerns(freeText: string): string {
  let text = freeText;
  while (text.includes(NO_WOUND_CONCERNS_SENTENCE)) {
    text = cutSentenceAt(text, text.indexOf(NO_WOUND_CONCERNS_SENTENCE));
  }
  return text;
}
