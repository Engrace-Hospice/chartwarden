// @chartwarden/shared — a patient-identifier screen for operator free text (pure). Lifted from M34's onboarding/phi-screen.ts
// + evidence.ts (and hardened since) so every module that stores an operator-typed note (M34's wizard, M23's NPI verification
// evidence, M35's add-on grant reason) screens it with the SAME rule: a module may not import another feature module (the
// manifest has no M23->M34 or M35->M34 edge), but a leaf is importable by all.
//
// Evidence notes, reasons and blocker text are typed by an operator, stored on a tenant-readable row and copied into the
// audit trail; none of them is a place for a patient. This is a best-effort guard against an accident (a customer's SSN read
// out on a call and pasted in), not a defence against someone hiding one.
//
// IT ERRS TOWARD REFUSING, and these are refused on purpose (the operator cites the document or ticket by name instead):
// a nine-digit ticket number; a ZIP+4 ("78701-1234"); a nine-digit number with a decimal point ("rate 12345.6789"); a dotted
// version shaped 3.2.4 ("100.10.1000"); nine single digits in a list ("steps 1, 2, 3, 4, 5, 6, 7, 8, 9"); and a standalone
// number grouped in threes ("123,456,789", e.g. an amount over a hundred million). A longer chain of digit groups
// ("1,234,567,890", an IP address "192.168.001.020") is not read as a three-by-three number.
//
// WHAT AN SSN LOOKS LIKE HERE: nine decimal digits (any script's: \p{Nd}) as 3-2-4 groups, as 3-3-3 groups standing alone, or
// as nine single digits, with anything that is not a letter or a number between the groups (whitespace, control characters,
// punctuation, symbols such as | + = ~ $ ^, dashes of every kind, slashes, underscores), up to ten characters in a row.
// Letters are never separators, so "ticket 123 of 45 and 6789" is not a number. A run of horizontal whitespace counts as ONE
// separator however long it is. 3-3-3 "standing alone" means no digit group continues it through a single separator that is not a
// line break: "1,234,567,890" and "192.168.001.020" are chains, but "SSN 900 123 456, 5 days" (a comma and a space), a number on the
// next line, or a list marker ("1. 900 123 456") do not make it part of one. A character that NFKD turns into a digit without being
// a decimal digit (superscripts, subscripts, circled digits) is judged twice: as the digit it folds to, and as a separator.
//
// The MBI rule follows `packages/billing/src/dde/notes.ts` (ADR-0052 D7): the text is NFKD-normalised, combining marks are
// dropped, what is left is squashed to letters and digits (spaces, dashes and zero-width characters vanish) and ANY
// 11-character MBI-shaped window is a hit.
//
// KNOWN GAPS (accepted): a Cyrillic/Greek lookalike for a letter or digit is not folded; digits written as words ("nine zero
// zero ..."), as CJK numerals, or as dingbat / enclosed forms that NFKD leaves alone; digits interleaved with letters; an
// identifier in another grouping (2-3-4, 4-5) or encoded (hex, base64); a value split across sentences; non-ASCII digits inside
// an MBI (its squash keeps ASCII letters and digits only); more than ten NON-whitespace separators between two groups; an
// UNBROKEN run of ten to twelve digits that contains an SSN ("9001234567": NPIs, phone numbers and ticket numbers pass on
// purpose); a 3-3-3 value with one separator and another number on either side ("900 123 456 5 days" reads as a longer chain).
import { ChartWardenError } from "@chartwarden/types";

const ND = "\\p{Nd}"; // any decimal digit, of any script
const SEP = "[^\\p{L}\\p{N}]"; // anything that is neither a letter nor a number
const SEP_NOT_LINE = "[^\\p{L}\\p{N}\\r\\n]"; // ... and is not a line break
const GAP = `${SEP}{0,10}`;
const GAP1 = `${SEP}{1,10}`;
// 3-2-4 groups. SSA never issues some of these, but the screen has no registry to consult and no reason to wave anything
// through. Adjacent digits may not continue the value on either side; more digit groups beyond a separator may (it is refused).
const SSN_GROUPED = new RegExp(`(?<!${ND})${ND}{3}${GAP}${ND}{2}${GAP}${ND}{4}(?!${ND})`, "u");
// 3-3-3 groups, only when the nine digits stand alone: not part of a longer chain of digit groups. A chain continues through at
// most ONE separator that is not a line break, so a comma-and-space, a line break or a list marker ends it.
const SSN_THREES = new RegExp(
  `(?<!${ND}${SEP_NOT_LINE}?)${ND}{3}${GAP1}${ND}{3}${GAP1}${ND}{3}(?!${SEP_NOT_LINE}?${ND})`,
  "u",
);
// Nine SINGLE digits, each set apart by separators ("9 0 0 1 2 3 4 5 6"). Every digit must stand alone, so a number whose
// digits come in runs (an amount, a date, a phone number) is never read as one.
const SSN_SPACED = new RegExp(`(?<!${ND})${ND}(?:${GAP1}${ND}){8}(?!${ND})`, "u");

// CMS MBI: position 1 is 1-9, positions 2, 5, 8 and 9 are letters, 3 and 6 a letter or digit, 4, 7, 10 and 11 digits;
// the letters S, L, O, I, B and Z are never used.
const MBI_LETTER = "[AC-HJKMNP-RT-Y]";
const MBI_LETTER_OR_DIGIT = "[AC-HJKMNP-RT-Y0-9]";
const MBI_WINDOW = new RegExp(
  `[1-9]${MBI_LETTER}${MBI_LETTER_OR_DIGIT}[0-9]${MBI_LETTER}${MBI_LETTER_OR_DIGIT}[0-9]${MBI_LETTER}${MBI_LETTER}[0-9]{2}`,
  "i",
);

// NFKD folds full-width digits and compatibility forms; combining marks and format characters (zero-width, bidi overrides) are dropped
// so padding cannot split a value; a run of horizontal whitespace is one separator (line breaks stay: they end a 3-3-3 chain).
const normalise = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/[\p{M}\p{Cf}]/gu, "")
    .replace(/[^\S\r\n]+/gu, " ");

// Characters of the "other number" class (superscripts, subscripts, circled digits) fold to digits under NFKD, which merges them
// with their neighbours when they were typed as separators ("900²12²3456"). So the text is judged twice: with them as the digits
// they fold to, and with each one a separator.
const OTHER_NUMBER = /\p{No}/gu;

/** True when the text holds something shaped like a US Social Security number. */
export function looksLikeSsn(text: string): boolean {
  return [normalise(text), normalise(text.replace(OTHER_NUMBER, " "))].some(
    (folded) => SSN_GROUPED.test(folded) || SSN_THREES.test(folded) || SSN_SPACED.test(folded),
  );
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
    const message = `${field} looks like it contains a patient identifier (a Social Security or Medicare number). Describe what was checked without naming a patient, and cite documents by their title or a ticket number. Long ids and UUIDs can also trip this check: cite them by title instead.`;
    throw new ChartWardenError(code, message, 422, [{ field, code, message }]);
  }
}
