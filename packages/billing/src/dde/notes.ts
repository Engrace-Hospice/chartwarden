// @wardenx/billing — DDE work-item free-text note rules (ADR-0052 D7). PURE.
//
// Notes are capped, never copied into events or logs, and rejected when they look like a Medicare Beneficiary
// Identifier: the queue never holds an MBI. The MBI format (CMS) is 11 characters: position 1 is 1-9, positions
// 2, 5, 8 and 9 are letters, 3 and 6 are a letter or digit, 4, 7, 10 and 11 are digits; the letters S, L, O, I,
// B and Z are never used. It is displayed as 4-3-4 with dashes, so separators after characters 4 and 7 are
// tolerated.

/** The most characters a DDE note may hold. */
export const DDE_NOTES_MAX_LENGTH = 500;

const ALPHA = "[AC-HJKMNP-RT-Y]";
const ALNUM = "[AC-HJKMNP-RT-Y0-9]";
const SEP = "[- ]?";

const MBI_PATTERN = new RegExp(
  `(?<![A-Z0-9])[1-9]${ALPHA}${ALNUM}[0-9]${SEP}${ALPHA}${ALNUM}[0-9]${SEP}${ALPHA}${ALPHA}[0-9][0-9](?![A-Z0-9])`,
  "i",
);

export type DdeNotesRejection = "NOTES_TOO_LONG" | "NOTES_CONTAIN_MBI";

export type DdeNotesValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: DdeNotesRejection };

/** True when the text contains something shaped like an MBI. */
export function looksLikeMbi(text: string): boolean {
  return MBI_PATTERN.test(text);
}

/** Validate an optional DDE note: length cap first, then the MBI-format screen. */
export function validateDdeNotes(notes: string | null | undefined): DdeNotesValidation {
  if (notes === null || notes === undefined) return { ok: true };
  if (notes.length > DDE_NOTES_MAX_LENGTH) return { ok: false, reason: "NOTES_TOO_LONG" };
  if (looksLikeMbi(notes)) return { ok: false, reason: "NOTES_CONTAIN_MBI" };
  return { ok: true };
}
