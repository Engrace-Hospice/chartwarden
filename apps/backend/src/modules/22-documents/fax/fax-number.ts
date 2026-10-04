// apps/backend/src/modules/22-documents/fax/fax-number.ts — normalise a fax number a person typed into E.164
// (F-238 outbound fax). Pure.
//
// Accepted: an international number with its "+" (E.164: + then 8–15 digits, no leading 0 country code), or a
// NANP number without one — 10 digits, or 11 starting with the country code 1. A NANP number (with or without
// "+1") must have a valid area code and exchange (first digit 2–9, not an N11 service code). Spaces, dots,
// dashes and parentheses are formatting and are dropped; anything else (letters, an extension) is refused —
// a fax machine cannot dial "ext. 12".

const NANP_PART = /^[2-9](?!11)\d{2}$/;

function nanp(ten: string): string | null {
  if (!/^\d{10}$/.test(ten)) return null;
  if (!NANP_PART.test(ten.slice(0, 3)) || !NANP_PART.test(ten.slice(3, 6))) return null;
  return `+1${ten}`;
}

/** E.164 (`+15035550100`) or null when the input is not a dialable fax number. */
export function normaliseFaxNumber(input: string): string | null {
  const compact = input.trim().replace(/[\s.\-()]/g, "");
  if (!/^\+?\d+$/.test(compact)) return null;
  if (compact.startsWith("+")) {
    const digits = compact.slice(1);
    if (digits.startsWith("1")) return nanp(digits.slice(1));
    return /^[2-9]\d{7,14}$/.test(digits) && digits.length <= 15 ? `+${digits}` : null;
  }
  if (compact.length === 11 && compact.startsWith("1")) return nanp(compact.slice(1));
  if (compact.length === 10) return nanp(compact);
  return null;
}
