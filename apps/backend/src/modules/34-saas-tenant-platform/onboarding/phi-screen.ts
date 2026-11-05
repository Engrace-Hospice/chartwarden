// apps/backend/src/modules/34-saas-tenant-platform/onboarding/phi-screen.ts — a patient-identifier screen for the
// wizard's free text (pure).
//
// Evidence notes, reasons and blocker text are typed by an operator, stored on the task and copied into the audit trail;
// none of them is a place for a patient. This is a best-effort guard against an accident (a customer's SSN read out on a
// call and pasted in), not a defence against someone hiding one. It errs on the side of refusing: a nine-digit ticket
// number is refused too, and the operator cites the document by name instead.
//
// The MBI rule follows `packages/billing/src/dde/notes.ts` (ADR-0052 D7), which M34 may not import (M34 does not depend
// on the billing module): the text is NFKD-normalised, combining marks are dropped, what is left is squashed to
// letters and digits (spaces, dashes and zero-width characters vanish) and ANY 11-character MBI-shaped window is a hit.
// KNOWN GAP (accepted, as there): a Cyrillic/Greek lookalike for a letter or digit is not folded, so it slips through.

// SSA never issues these, but the screen has no registry to consult and no reason to wave anything through.
const SSN = /(?<!\d)\d{3}[\s.-]?\d{2}[\s.-]?\d{4}(?!\d)/u;

// CMS MBI: position 1 is 1-9, positions 2, 5, 8 and 9 are letters, 3 and 6 a letter or digit, 4, 7, 10 and 11 digits;
// the letters S, L, O, I, B and Z are never used.
const MBI_LETTER = "[AC-HJKMNP-RT-Y]";
const MBI_LETTER_OR_DIGIT = "[AC-HJKMNP-RT-Y0-9]";
const MBI_WINDOW = new RegExp(
  `[1-9]${MBI_LETTER}${MBI_LETTER_OR_DIGIT}[0-9]${MBI_LETTER}${MBI_LETTER_OR_DIGIT}[0-9]${MBI_LETTER}${MBI_LETTER}[0-9]{2}`,
  "i",
);

const normalise = (text: string): string => text.normalize("NFKD").replace(/\p{M}/gu, "");

/** True when the text holds something shaped like a US Social Security number. */
export function looksLikeSsn(text: string): boolean {
  return SSN.test(normalise(text));
}

/** True when the text holds something shaped like a Medicare Beneficiary Identifier. */
export function looksLikeMbi(text: string): boolean {
  return MBI_WINDOW.test(normalise(text).replace(/[^A-Za-z0-9]/g, ""));
}

/** True when the text holds an SSN- or MBI-shaped value. */
export function looksLikePatientIdentifier(text: string): boolean {
  return looksLikeSsn(text) || looksLikeMbi(text);
}
