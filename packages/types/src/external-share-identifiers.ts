// M36 WP 6.6 (ADR-0096 D16) - the partner-visible identifier matcher: a PURE, fail-closed check on the plaintext of a message that is about to be shown to
// an external partner. A message that matches any high-signal pattern is WITHHELD (omitted), never masked: a masked identifier still tells the reader
// what kind of message it was, and a regex mask that misses one character leaks the rest.
//
// WHAT THIS IS NOT: it does not detect names, nicknames, relationships, diagnoses, indirect identifiers ("the lady in room 214 with the daughter in
// Boise") or anything a person can write in free text. It reduces the exposure to the most mechanical identifiers; it does not eliminate it, and the
// staff create dialog says so. It never logs, stores or returns the text: only the KINDS that matched, for a count and a test.
//
// Covered kinds: ssn (123-45-6789), long_number (any run of 6+ digits: MRN, account, member, phone without separators, 9-digit SSN),
// labelled_identifier (the labels MRN, DOB, DOS, SSN, account/policy/member/patient id forms), date_numeric (4/12/1950, 04-12-50), date_iso
// (1950-04-12), date_named (April 12, 1950 / 12 April 1950), phone (555-123-4567, (555) 123-4567, +1 555 123 4567), email, street_address
// (123 Main Street and the road/avenue/boulevard/drive/lane/highway/terrace family).
// Deliberately NOT covered (too ambiguous in clinical shorthand): 7-digit local numbers (555-1234), two-part dates (10/23), bare years, 5-digit numbers
// (room, lot, zip), and the short street suffixes st/dr/ct/way/place.

export const PARTNER_IDENTIFIER_KINDS = [
  "ssn",
  "long_number",
  "labelled_identifier",
  "date_numeric",
  "date_iso",
  "date_named",
  "phone",
  "email",
  "street_address",
] as const;
export type PartnerIdentifierKind = (typeof PARTNER_IDENTIFIER_KINDS)[number];

const MONTHS =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const RULES: ReadonlyArray<readonly [PartnerIdentifierKind, RegExp]> = [
  ["ssn", /\b\d{3}[- ]\d{2}[- ]\d{4}\b/],
  ["long_number", /\d{6,}/],
  [
    "labelled_identifier",
    /\b(?:mrn|dob|d\.o\.b\.?|dos|ssn|acct|account\s*(?:no|number|#)|medicaid\s*id|medicare\s*id|member\s*id|policy\s*(?:no|number|#)|patient\s*id)\b/i,
  ],
  ["date_numeric", /\b(?:0?[1-9]|1[0-2])[/.-](?:0?[1-9]|[12]\d|3[01])[/.-](?:\d{4}|\d{2})\b/],
  ["date_iso", /\b(?:19|20)\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/],
  [
    "date_named",
    new RegExp(
      `\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+(?:19|20)\\d{2}\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?,?\\s+(?:19|20)\\d{2}\\b`,
      "i",
    ),
  ],
  ["phone", /(?:\+?1[ .-]?)?\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/],
  ["email", /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/],
  [
    "street_address",
    /\b\d{1,5}\s+(?:[A-Za-z0-9.'-]+\s+){0,3}(?:street|avenue|ave|road|rd|boulevard|blvd|drive|lane|highway|hwy|terrace)\b/i,
  ],
];

/** The kinds of identifier found in `text`, in rule order (empty when none). Pure; never throws; the text is not returned or logged. */
export function findPartnerIdentifierKinds(text: string): PartnerIdentifierKind[] {
  const found: PartnerIdentifierKind[] = [];
  for (const [kind, pattern] of RULES) if (pattern.test(text)) found.push(kind);
  return found;
}

/** True when a partner must not be shown this message (fail closed). */
export function containsPartnerIdentifier(text: string): boolean {
  return RULES.some(([, pattern]) => pattern.test(text));
}
