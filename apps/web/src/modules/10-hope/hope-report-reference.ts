// apps/web/src/modules/10-hope — the "Report reference" and the row codes an operator types when recording a CMS result: the server's
// charset and length, mirrored so the dialog refuses what the server would refuse, and the words it says on the field when the
// server refuses it anyway. Every sentence is static: the text typed is never echoed, and the wire field's name (`reportReference`)
// is for matching, never for showing. hope-mirror-parity.test.ts compares these mirrors with the server's sources.
import { PHI_REFUSAL_CODE, type WriteResult } from "./hope-api";

/** The server's length limit on a report reference (`HOPE_REFERENCE_MAX_LENGTH` in hope-typebox.ts). */
export const MAX_REFERENCE = 128;

/**
 * Mirror of `HOPE_TOKEN_PATTERN` in `apps/backend/src/modules/10-hope/routes/hope-typebox.ts` (web does not import backend code:
 * keep the two identical): letters, digits and `. _ : # / -`, with spaces allowed after the FIRST character, so markup, control
 * characters and quotes never reach a stored row and a value of spaces is refused. The dialog trims first, so a reference of spaces
 * alone is left empty (no reference), never sent.
 */
export const REFERENCE_PATTERN = /^[A-Za-z0-9._:#/-][A-Za-z0-9 ._:#/-]*$/;

/**
 * Whether a (trimmed) reference is one the server refuses: a character outside the pattern, or more than {@link MAX_REFERENCE}.
 * Nothing at all is fine: the reference is optional and then not sent.
 */
export const hasForbiddenReferenceCharacter = (trimmedText: string): boolean =>
  trimmedText !== "" &&
  (trimmedText.length > MAX_REFERENCE || !REFERENCE_PATTERN.test(trimmedText));

/** The server's limit on one result-row code (`HOPE_RESULT_TOKEN_MAX_LENGTH`): the CMS code and the item code. */
export const MAX_RESULT_TOKEN = 64;

/**
 * Mirror of `HOPE_RESULT_CODE_PATTERN` (hope-typebox.ts): a CMS edit code or item code is ONE word of letters, digits and `. _ : # -`
 * (a leading `-` is allowed: edit codes look like `-3015`), with NO space and NO slash, or EMPTY (a blank cell names nothing). The
 * dialog trims first, so spaces alone are an empty cell, never sent. The web sends no severity and no iQIES record id, so it mirrors
 * neither `HOPE_RESULT_SEVERITY_PATTERN` nor the record id's use of this pattern.
 */
export const RESULT_CODE_PATTERN = /^(?:[A-Za-z0-9._:#-]{1,64})?$/;

/** Whether a (trimmed) CMS code or item code is one the server refuses: not one word of that charset, or more than {@link MAX_RESULT_TOKEN}. */
export const hasForbiddenResultCode = (trimmedText: string): boolean =>
  trimmedText.length > MAX_RESULT_TOKEN || !RESULT_CODE_PATTERN.test(trimmedText);

export const RESULT_CODE_WORDS = `A CMS code or item is one word: letters, digits and . _ : # - only, up to ${MAX_RESULT_TOKEN} characters, with no spaces or slashes.`;

/**
 * Mirror of `UNSTORABLE_MESSAGE` in hope-reference-screen.ts: a control character other than tab, line feed and carriage return, or a
 * lone surrogate. The server refuses them with a 422 INVALID_CHARACTERS. Only NUL and an unpaired surrogate are what Postgres cannot
 * store (they would be a 500); refusing every other control character is the server's own policy choice, mirrored so the operator is
 * told on the row before confirming. A pasted report, or a cut at the length limit, can leave one. The server's patient-identifier
 * screen of the message is its own, and its refusal is shown as the server's words (it names the row and the field, never the text).
 */
export const UNSTORABLE_MESSAGE =
  /(?![\t\n\r])\p{Cc}|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

/** Whether a (trimmed) result message holds a character the server refuses to store. */
export const hasUnstorableMessage = (trimmedText: string): boolean =>
  UNSTORABLE_MESSAGE.test(trimmedText);

export const MESSAGE_WORDS =
  "A message has a character that cannot be recorded (a control character or a broken emoji). Retype that message.";

export const REFERENCE_HINT = `Letters, digits, spaces and . _ : # / - only, up to ${MAX_REFERENCE} characters.`;

/** What the server refused the reference for. */
export type ReferenceRefusal = "invalid_characters" | "looks_like_phi";

/** The wire field the server names when it refuses the reference (matched, never shown). */
export const REFERENCE_FIELD = "reportReference";

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

/** The one cell of a result row a refusal names (`results.<row>.<token>`): `row` is 0-based, as the server counts the rows it was sent. */
export interface RowRefusal {
  readonly row: number;
  readonly token: string;
}

const ROW_FIELD = /^results\.(\d+)\.([A-Za-z]+)$/;

/**
 * Which cell of which row a refused result names, or null (the refusal names no row: the server's words stand alone). The server's words
 * name the row and the field but not WHERE it is on a long, scrolling table, so the dialog marks the cell and says "Row N" itself. The
 * dialog sends one row per item, in order, so the server's row index is the item's index.
 */
export function rowRefusalOf(
  refusal: Extract<WriteResult<unknown>, { ok: false }>,
): RowRefusal | null {
  const found = ROW_FIELD.exec(refusal.invalidField?.field ?? "");
  if (found === null) return null;
  return { row: Number(found[1]), token: found[2] as string };
}
