// @chartwarden/shared — a patient-identifier screen for operator free text (pure). Lifted from M34's onboarding/phi-screen.ts +
// evidence.ts (and hardened since: any whitespace/punctuation separator, digit-by-digit spacing) so every module that stores an operator-typed note (M34's wizard, M23's NPI
// verification evidence, M35's add-on grant reason) screens it with the SAME rule: a module may not import another feature
// module (the manifest has no M23->M34 or M35->M34 edge), but a leaf is importable by all.
//
// Evidence notes, reasons and blocker text are typed by an operator, stored on a tenant-readable row and copied into the
// audit trail; none of them is a place for a patient. This is a best-effort guard against an accident (a customer's SSN read
// out on a call and pasted in), not a defence against someone hiding one. It errs on the side of refusing: a nine-digit
// ticket number is refused too, and the operator cites the document by name instead.
//
// The MBI rule follows `packages/billing/src/dde/notes.ts` (ADR-0052 D7): the text is NFKD-normalised, combining marks are
// dropped, what is left is squashed to letters and digits (spaces, dashes and zero-width characters vanish) and ANY
// 11-character MBI-shaped window is a hit.
// KNOWN GAP (accepted, as there): a Cyrillic/Greek lookalike for a letter or digit is not folded, so it slips through.
import { ChartWardenError } from "@chartwarden/types";

// SEPARATOR between digit groups: any whitespace, Unicode space, or punctuation (hyphen, en/em dash, the non-breaking
// hyphen U+2011, slash, underscore, dot, comma, colon ...), up to three of them in a row ("900 - 12 - 3456", "900  12  3456").
// Letters never separate: "ticket 123 of 45 ..." is not a number.
const SEP = "[\\s\\p{Z}\\p{P}]";
// 3-2-4 digit groups with any such separator (or none) between them. SSA never issues some of these, but the screen has no
// registry to consult and no reason to wave anything through.
const SSN_GROUPED = new RegExp(`(?<!\\d)\\d{3}${SEP}{0,3}\\d{2}${SEP}{0,3}\\d{4}(?!\\d)`, "u");
// Nine SINGLE digits, each set apart by separators ("9 0 0 1 2 3 4 5 6", "9-0-0-..."). Every digit must stand alone, so an
// amount ("$1,234,567.89"), a date or a phone number, whose digits come in runs, is never read as one.
const SSN_SPACED = new RegExp(`(?<!\\d)\\d(?:${SEP}{1,3}\\d){8}(?!\\d)`, "u");

// CMS MBI: position 1 is 1-9, positions 2, 5, 8 and 9 are letters, 3 and 6 a letter or digit, 4, 7, 10 and 11 digits;
// the letters S, L, O, I, B and Z are never used.
const MBI_LETTER = "[AC-HJKMNP-RT-Y]";
const MBI_LETTER_OR_DIGIT = "[AC-HJKMNP-RT-Y0-9]";
const MBI_WINDOW = new RegExp(
  `[1-9]${MBI_LETTER}${MBI_LETTER_OR_DIGIT}[0-9]${MBI_LETTER}${MBI_LETTER_OR_DIGIT}[0-9]${MBI_LETTER}${MBI_LETTER}[0-9]{2}`,
  "i",
);

// NFKD folds full-width digits and compatibility forms; combining marks and format characters (zero-width, bidi overrides) are dropped
// so padding cannot split a value.
const normalise = (text: string): string => text.normalize("NFKD").replace(/[\p{M}\p{Cf}]/gu, "");

/** True when the text holds something shaped like a US Social Security number. */
export function looksLikeSsn(text: string): boolean {
  const folded = normalise(text);
  return SSN_GROUPED.test(folded) || SSN_SPACED.test(folded);
}

/** True when the text holds something shaped like a Medicare Beneficiary Identifier. */
export function looksLikeMbi(text: string): boolean {
  return MBI_WINDOW.test(normalise(text).replace(/[^A-Za-z0-9]/g, ""));
}

/** True when the text holds an SSN- or MBI-shaped value. */
export function looksLikePatientIdentifier(text: string): boolean {
  return looksLikeSsn(text) || looksLikeMbi(text);
}

/**
 * Refuses (422, never echoing the value) text that holds a patient identifier. The one screen every operator free text shares.
 * The screen itself drops format characters (`\p{Cf}`: zero-width, bidi overrides) before judging. M34's own text cleaning strips
 * only control characters (`\p{Cc}`), so the callers that store the text as typed (M23, M35) depend on this.
 */
export function assertNoPatientIdentifier(field: string, text: string): void {
  if (looksLikePatientIdentifier(text)) {
    const code = "EVIDENCE_LOOKS_LIKE_PHI";
    const message = `${field} looks like it contains a patient identifier (a Social Security or Medicare number). Describe what was checked without naming a patient, and cite documents by their title.`;
    throw new ChartWardenError(code, message, 422, [{ field, code, message }]);
  }
}
