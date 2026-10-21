// @chartwarden/billing — DDE work-item free-text note rules (ADR-0052 D7). PURE.
//
// Notes are capped, never copied into events or logs, and rejected when they look like a Medicare Beneficiary
// Identifier: the queue never holds an MBI. The MBI format (CMS) is 11 characters: position 1 is 1-9, positions
// 2, 5, 8 and 9 are letters, 3 and 6 are a letter or digit, 4, 7, 10 and 11 are digits; the letters S, L, O, I,
// B and Z are never used. It is displayed as 4-3-4 with dashes; see the screen below for how that is tolerated.

/** The most characters a DDE note may hold. */
export const DDE_NOTES_MAX_LENGTH = 500;

// Best-effort screen. The text is NFKD-normalised (full-width digits become ASCII, accented letters lose their marks),
// every combining mark is dropped, and what is left is squashed to letters and digits: spaces, tabs, NBSP, dots,
// dashes and zero-width characters vanish. A remaining NON-ASCII letter (a Cyrillic or Greek lookalike) becomes the
// wildcard `~` and a non-ASCII number becomes `#` instead of being deleted, so one lookalike cannot shorten the string.
// A wildcard only stands in at a position of its own kind: a letter lookalike where the MBI has a letter, a numeral
// where it has a digit. KNOWN GAP (accepted): a non-ASCII LETTER used as a lookalike for a DIGIT (Cyrillic Ze for 3,
// O for 0, Che for 4) becomes `~` at a digit position and does not match, so `1EG4-TE5-MK7<Ze>` passes. Allowing a
// letter wildcard at digit positions would flag ordinary non-Latin prose, which the screen must not do. Then ANY
// 11-character MBI-shaped window is searched, with no boundary assumptions. It can false-positive on odd text; that
// is the safe side. This is a guard against accidents, not a defence against someone determined to hide an MBI.
const ALPHA = "[AC-HJKMNP-RT-Y~]";
const ALNUM = "[AC-HJKMNP-RT-Y0-9~#]";
const DIGIT = "[0-9#]";
const MBI_WINDOW = new RegExp(
  `[1-9#]${ALPHA}${ALNUM}${DIGIT}${ALPHA}${ALNUM}${DIGIT}${ALPHA}${ALPHA}${DIGIT}${DIGIT}`,
  "i",
);

function squash(text: string): string {
  const decomposed = text.normalize("NFKD").replace(/\p{M}/gu, "");
  let out = "";
  for (const ch of decomposed) {
    if (/[A-Za-z0-9]/.test(ch)) out += ch;
    else if (/\p{N}/u.test(ch)) out += "#";
    else if (/\p{L}/u.test(ch)) out += "~";
  }
  return out;
}

export type DdeNotesRejection = "NOTES_TOO_LONG" | "NOTES_CONTAIN_MBI";

export type DdeNotesValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: DdeNotesRejection };

/** True when the text contains something shaped like an MBI. */
export function looksLikeMbi(text: string): boolean {
  return MBI_WINDOW.test(squash(text));
}

/** Validate an optional DDE note: length cap first, then the MBI-format screen. */
export function validateDdeNotes(notes: string | null | undefined): DdeNotesValidation {
  if (notes === null || notes === undefined) return { ok: true };
  if (notes.length > DDE_NOTES_MAX_LENGTH) return { ok: false, reason: "NOTES_TOO_LONG" };
  if (looksLikeMbi(notes)) return { ok: false, reason: "NOTES_CONTAIN_MBI" };
  return { ok: true };
}

/** The outcome codes an operator may record (a closed set: a free-form code is a place to hide an identifier). */
export const DDE_OUTCOME_CODES = [
  "accepted",
  "accepted_with_edits",
  "rtp",
  "rejected",
  "adr_requested",
  "other",
] as const;
export type DdeOutcomeCode = (typeof DDE_OUTCOME_CODES)[number];

/** A DCN / ICN is a 13 to 23 character control number; an 11-character value (an MBI's length) is refused. */
export const DDE_DCN_PATTERN = /^[A-Za-z0-9]{13,23}$/;

export type DdeCodeRejection = "DCN_INVALID" | "RTP_CODE_INVALID" | "CODE_LOOKS_LIKE_MBI";

/** Validate the code-shaped fields of an outcome: shape first, then the MBI screen on each. */
export function validateDdeCodes(codes: {
  readonly dcn?: string | null;
  readonly rtpReasonCode?: string | null;
  readonly outcomeCode?: string | null;
}):
  | { readonly ok: true }
  | { readonly ok: false; readonly field: string; readonly reason: DdeCodeRejection } {
  if (codes.dcn != null && !DDE_DCN_PATTERN.test(codes.dcn))
    return { ok: false, field: "dcn", reason: "DCN_INVALID" };
  if (codes.rtpReasonCode != null && !/^[A-Z0-9]{1,8}$/.test(codes.rtpReasonCode))
    return { ok: false, field: "rtpReasonCode", reason: "RTP_CODE_INVALID" };
  for (const field of ["dcn", "rtpReasonCode", "outcomeCode"] as const) {
    const value = codes[field];
    if (typeof value === "string" && looksLikeMbi(value))
      return { ok: false, field, reason: "CODE_LOOKS_LIKE_MBI" };
  }
  return { ok: true };
}
