// apps/web/src/modules/10-hope — the "Report reference" an operator types when recording a CMS result: the server's charset and
// length, mirrored so the dialog refuses what the server would refuse, and the words it says on the field when the server refuses
// it anyway. Every sentence is static: the reference typed is never echoed, and the wire field's name (`reportReference`) is for
// matching, never for showing.
import type { WriteResult } from "./hope-api";

/** The server's length limit on a report reference (`referenceString(128)` in `ImportSubmissionResultSchema`, hope-typebox.ts). */
export const MAX_REFERENCE = 128;

/**
 * Mirror of the server's reference pattern in `apps/backend/src/modules/10-hope/routes/hope-typebox.ts` (web does not import backend code:
 * keep the two identical): letters, digits and `. _ : # / -`, with spaces allowed after the FIRST character, so markup, control
 * characters and quotes never reach a stored row and a value of spaces is refused. The dialog trims first, so a reference of spaces
 * alone is left empty (no reference), never sent.
 */
const REFERENCE_PATTERN = /^[A-Za-z0-9._:#/-][A-Za-z0-9 ._:#/-]*$/;

/**
 * Whether a (trimmed) reference is one the server refuses: a character outside the pattern, or more than {@link MAX_REFERENCE}.
 * Nothing at all is fine: the reference is optional and then not sent.
 */
export const hasForbiddenReferenceCharacter = (trimmedText: string): boolean =>
  trimmedText !== "" &&
  (trimmedText.length > MAX_REFERENCE || !REFERENCE_PATTERN.test(trimmedText));

export const REFERENCE_HINT = `Letters, digits, spaces and . _ : # / - only, up to ${MAX_REFERENCE} characters.`;

/** What the server refused the reference for. */
export type ReferenceRefusal = "invalid_characters" | "looks_like_phi";

const PHI_REFUSAL_CODE = "EVIDENCE_LOOKS_LIKE_PHI";
const REFERENCE_FIELD = "reportReference";

export const REFERENCE_REFUSAL_WORDS: Readonly<Record<ReferenceRefusal, string>> = {
  invalid_characters: `That reference has a character that is not allowed. Use only letters, digits, spaces and . _ : # / -, up to ${MAX_REFERENCE} characters.`,
  looks_like_phi:
    "This looks like it contains a Social Security or Medicare number. Enter the reference CMS gave for the report, never a patient's number.",
};

/**
 * What a refused result says about the reference, or null when the refusal is not about it (the caller keeps the server's words). The
 * patient-identifier screen answers one code for the reference AND for every result row's tokens (`results.<i>.<token>`), so it is the
 * reference's only when its detail names `reportReference`; a validation refusal likewise (the charset answers "Expected union value",
 * which says nothing to a clinician).
 */
export function referenceRefusalOf(
  refusal: Extract<WriteResult<unknown>, { ok: false }>,
): ReferenceRefusal | null {
  if (refusal.invalidField?.field !== REFERENCE_FIELD) return null;
  return refusal.code === PHI_REFUSAL_CODE ? "looks_like_phi" : "invalid_characters";
}
