// M36 WP 6.6 (ADR-0096 D16) - the partner-visible identifier matcher: a PURE, fail-closed check on the plaintext of a message that is about to be shown to
// an external partner. A message that matches any high-signal pattern is WITHHELD (omitted), never masked: a masked identifier still tells the reader
// what kind of message it was, and a regex mask that misses one character leaks the rest.
//
// WHAT THIS IS NOT: it does not detect names, nicknames, relationships, diagnoses, indirect identifiers ("the lady in room 214 with the daughter in
// Boise") or anything a person can write in free text. It reduces the exposure to the most mechanical identifiers; it does not eliminate it, and the
// staff create dialog says so. It never logs, stores or returns the text: only the KINDS that matched, for a count and a test.
//
// NORMALISATION (so the obvious evasions do not work): the text is NFKC-normalised (fullwidth digits and letters become ASCII), every format character
// (\p{Cf}: zero-width space/joiner, soft hyphen, bidi marks) is deleted, and every other Unicode decimal digit (Arabic-Indic, Devanagari, ...) is mapped
// to its ASCII value. A second, COLLAPSED view deletes whitespace that sits BETWEEN digits and the dashes of a chain of three or more digit groups, so
// "1 2 3 4 5 6", "123-456-789" and "12 34 56" count as a run of 6+ digits (a two-part range such as "250-1000 mg" is not joined).
//
// Covered kinds: ssn (123-45-6789), long_number (a run of 6+ digits in either view: MRN, account, member numbers, a phone or a 9-digit SSN without
// separators, spaced or dashed digit groups), labelled_identifier (the labels MRN, DOB, DOS, SSN, ACCT, account/policy/member/patient id forms, also
// glued to what follows: "MRN123", "DOB:4/12/50"), date_numeric (4/12/1950, 04-12-50), date_iso (1887-03-12, 1950/04/12), date_named (April 12, 1950
// and 12 April 1887; years 1800 to 2099), phone, email, street_address (123 Main Street and the road/avenue/boulevard/drive/lane/highway/terrace family).
//
// FALSE-POSITIVE COST (accepted, fail-closed): any six-digit number is withheld (a lot or order number, a long lab accession), and so is a list of
// UNLABELLED numbers separated only by spaces or dashes that adds up to 6+ digits ("120 80 76 98"). Labelled vitals and labs ("BP 120/80, HR 88, INR 2.5,
// K 4.1, glucose 142 mg/dL") pass because a letter, a slash, a colon, a comma or a decimal point sits between the numbers, so the collapsed view never joins them.
// Deliberately NOT covered (too ambiguous in clinical shorthand): 7-digit local numbers (555-1234), two-part dates (10/23), bare years, 5-digit numbers
// (room, lot, zip), dot-separated digit groups outside a phone pattern, the short street suffixes st/dr/ct/way/place, spelled-out digits ("one two
// three"), letter homoglyphs for digits, and an identifier split by letters ("M R N").

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
const YEAR = "(?:18|19|20)\\d{2}";

const PLAIN_RULES: ReadonlyArray<readonly [PartnerIdentifierKind, RegExp]> = [
  ["ssn", /\b\d{3}[- ]\d{2}[- ]\d{4}\b/],
  [
    "labelled_identifier",
    /(?<![a-z])(?:mrn|dob|d\.o\.b\.?|dos|ssn|acct|account\s*(?:no|number|#)|medicaid\s*id|medicare\s*id|member\s*id|policy\s*(?:no|number|#)|patient\s*id)(?![a-z])/i,
  ],
  ["date_numeric", /\b(?:0?[1-9]|1[0-2])[/.-](?:0?[1-9]|[12]\d|3[01])[/.-](?:\d{4}|\d{2})\b/],
  [
    "date_iso",
    new RegExp(
      `\\b${YEAR}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])\\b|\\b${YEAR}/(?:0?[1-9]|1[0-2])/(?:0?[1-9]|[12]\\d|3[01])\\b`,
    ),
  ],
  [
    "date_named",
    new RegExp(
      `\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+${YEAR}\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\.?,?\\s+${YEAR}\\b`,
      "i",
    ),
  ],
  ["phone", /(?:\+?1[ .-]?)?\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/],
  [
    "street_address",
    /\b\d{1,5}\s+(?:[A-Za-z0-9.'-]+\s+){0,3}(?:street|avenue|ave|road|rd|boulevard|blvd|drive|lane|highway|hwy|terrace)\b/i,
  ],
];

const LONG_NUMBER = /\d{6,}/;
/** Most "@" signs examined and the longest local part / domain looked at: keeps the email check linear whatever the input. */
const EMAIL_AT_LIMIT = 50;
const EMAIL_LOCAL_MAX = 64;
const EMAIL_DOMAIN_MAX = 255;
const LOCAL_TAIL = /[A-Za-z0-9._%+-]$/;
const DOMAIN_HEAD = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;

/** The ASCII value of any Unicode decimal digit (they come in runs of ten starting at zero). */
function asciiDigit(char: string): string {
  let code = char.codePointAt(0) ?? 0;
  let value = 0;
  while (value < 9 && /^\p{Nd}$/u.test(String.fromCodePoint(code - 1))) {
    code -= 1;
    value += 1;
  }
  return String(value);
}

/** The text a partner would effectively read, with width, format characters and non-ASCII digits removed. */
function normalised(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/\p{Nd}/gu, (c) => (c >= "0" && c <= "9" ? c : asciiDigit(c)));
}

/** Dash-joined digit groups: a chain of THREE or more groups ("123-456-789"), so a two-part dosing range ("250-1000 mg") is left alone. */
const DASH_CHAIN = /\d+(?:\s*[-\u2010-\u2015]\s*\d+){2,}/g;

/** Whitespace and similar joiners that sit between two digits are deleted, and so are the dashes of a chain of three or more digit groups. */
function collapsed(plain: string): string {
  return plain
    .replace(DASH_CHAIN, (chain) => chain.replace(/[\s\-\u2010-\u2015]/g, ""))
    .replace(/(?<=\d)[\s_\u00b7\u2022]+(?=\d)/g, "");
}

function hasEmail(text: string): boolean {
  let from = 0;
  for (let n = 0; n < EMAIL_AT_LIMIT; n += 1) {
    const at = text.indexOf("@", from);
    if (at === -1) return false;
    const local = text.slice(Math.max(0, at - EMAIL_LOCAL_MAX), at);
    const domain = text.slice(at + 1, at + 1 + EMAIL_DOMAIN_MAX);
    if (LOCAL_TAIL.test(local) && DOMAIN_HEAD.test(domain)) return true;
    from = at + 1;
  }
  return false;
}

/** The kinds of identifier found in `text`, in rule order (empty when none). Pure; never throws; the text is not returned or logged. */
export function findPartnerIdentifierKinds(text: string): PartnerIdentifierKind[] {
  const plain = normalised(text);
  const joined = collapsed(plain);
  const found = new Set<PartnerIdentifierKind>();
  for (const [kind, pattern] of PLAIN_RULES) if (pattern.test(plain)) found.add(kind);
  if (LONG_NUMBER.test(plain) || LONG_NUMBER.test(joined)) found.add("long_number");
  if (hasEmail(plain)) found.add("email");
  return PARTNER_IDENTIFIER_KINDS.filter((k) => found.has(k));
}

/** True when a partner must not be shown this message (fail closed). */
export function containsPartnerIdentifier(text: string): boolean {
  return findPartnerIdentifierKinds(text).length > 0;
}
