// apps/web/src/modules/10-hope — the justification an administrative late-deadline override must carry: the server's bounds and its
// character rule, mirrored so the recording dialog refuses what the server would refuse, and the words the dialog says on the field
// when the server refuses it anyway. Every sentence here is static: the text typed is never echoed, and the wire field's name
// (`adminOverrideJustification`) is for matching, never for showing.
import type { WriteResult } from "./hope-api";

/**
 * The server's own bounds on the justification (`RecordTimepointSchema.adminOverrideJustification`; `requireOverrideJustification`
 * refuses an override without one). The maximum is measured on the trimmed text as it is; the minimum on that text with each run of
 * Unicode White_Space collapsed to one space, so no-break spaces and line or paragraph separators cannot pad a reason to the minimum
 * ({@link justificationLengthOk}). The text the server keeps is the trimmed text, never the collapsed one.
 */
export const OVERRIDE_JUSTIFICATION_MIN = 20;
export const OVERRIDE_JUSTIFICATION_MAX = 1000;

/** Mirror of `WHITE_SPACE_RUN` in hope-route-guards.ts (kept identical: hope-mirror-parity.test.ts). */
export const WHITE_SPACE_RUN = /\p{White_Space}+/gu;

/** Whether the TRIMMED justification is within the server's bounds, measured as the server measures them. */
export const justificationLengthOk = (trimmedText: string): boolean =>
  trimmedText.length <= OVERRIDE_JUSTIFICATION_MAX &&
  trimmedText.replace(WHITE_SPACE_RUN, " ").length >= OVERRIDE_JUSTIFICATION_MIN;

/**
 * Mirror of `FORBIDDEN_JUSTIFICATION_CHARACTER` in `apps/backend/src/modules/10-hope/routes/hope-route-guards.ts` (web does not import
 * backend code: keep the two identical). Control characters other than tab and line breaks, zero-width and other format characters
 * (zero-width space, LRM, soft hyphen, BOM...) and a lone surrogate. The server REJECTS them, never strips them, and tests the TRIMMED
 * text, so callers of {@link hasForbiddenJustificationCharacter} pass the trimmed text.
 */
export const FORBIDDEN_JUSTIFICATION_CHARACTER =
  /(?![\t\n\r])[\p{Cc}\p{Cf}]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/** Whether the (trimmed) justification holds a character the server refuses: a paste often carries one nobody can see. */
export const hasForbiddenJustificationCharacter = (trimmedText: string): boolean =>
  FORBIDDEN_JUSTIFICATION_CHARACTER.test(trimmedText);

/** What the server refused the justification for, as far as the dialog words it differently. */
export type JustificationRefusal = "looks_like_phi" | "invalid_characters" | "not_accepted";

/**
 * The code the server answers (422) when the justification looks like a patient identifier. Its own words are written for an evidence
 * note ("describe what was checked", "cite documents") and name the wire field, so the clinician is told these instead, on the field.
 * Static on purpose: the field's error is an alert, announced again on every change of its text.
 */
const PHI_REFUSAL_CODE = "EVIDENCE_LOOKS_LIKE_PHI";
const JUSTIFICATION_FIELD = "adminOverrideJustification";
const INVALID_CHARACTERS_CODE = "INVALID_CHARACTERS";

export const JUSTIFICATION_REFUSAL_WORDS: Readonly<Record<JustificationRefusal, string>> = {
  looks_like_phi:
    "This looks like it contains a Social Security or Medicare number. Say why this record is being entered after the late deadline, without naming a patient or quoting an identifier. A long ID number can trip this check, so leave it out.",
  invalid_characters:
    "Contains invisible or formatting characters, often from pasted text. Retype the text instead of pasting it.",
  not_accepted: `The justification was not accepted. Check that it is between ${OVERRIDE_JUSTIFICATION_MIN} and ${OVERRIDE_JUSTIFICATION_MAX} characters of plain text, then record again.`,
};

/**
 * What a refused record says about the justification, or null when the refusal is not about it (the caller keeps the server's words).
 * Only a refusal whose detail names the justification's own field is: the patient-identifier screen answers one code whichever field
 * it screened, so the code alone is not enough.
 */
export function justificationRefusalOf(
  refusal: Extract<WriteResult<unknown>, { ok: false }>,
): JustificationRefusal | null {
  if (refusal.invalidField?.field !== JUSTIFICATION_FIELD) return null;
  if (refusal.code === PHI_REFUSAL_CODE) return "looks_like_phi";
  return refusal.invalidField.code === INVALID_CHARACTERS_CODE
    ? "invalid_characters"
    : "not_accepted";
}
