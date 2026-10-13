// @wardenx/messaging - the "no PHI in saved replies" lint (M36 WP 2.8).
//
// Deterministic and server-side: it runs on every template save (personal, shared and overlay) and again when a stored
// template is resolved for a picker, so a rule set that is tightened later also covers rows saved under the old one.
// It returns CODES only, never the matched text, so a refusal cannot echo an identifier back into a response or a log.
//
// WHAT IT IS: a screen for direct, pattern-shaped identifiers (SSN, phone, email, dates, long digit runs, labelled
// MRN/DOB/insurance ids, Medicare MBI, URLs, IPs, street addresses, "Mrs. Surname", merge placeholders).
// WHAT IT IS NOT: a PHI detector. It cannot see a bare first name, a diagnosis, a medication, a free-text description
// of a patient, a number written out in words, or an identifier in an unlisted shape. Those are controlled by the
// non-clinical category list, the admin-only authorship of shared templates, and the fact that a template is plain
// text with no merge fields (nothing patient-specific is ever substituted by the system). Never present a pass as
// "contains no PHI".

/** Bump when a rule is added or tightened; recorded so an operator can tell which rule set accepted a row. */
export const PHI_LINT_VERSION = 2;

export type PhiFindingCode =
  | "DATE"
  | "EMAIL"
  | "HONORIFIC_NAME"
  | "IDENTIFIER_LABEL"
  | "IP_ADDRESS"
  | "LONG_NUMBER"
  | "MBI"
  | "PHONE"
  | "PLACEHOLDER"
  | "SSN"
  | "STREET_ADDRESS"
  | "URL";

const MONTH =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const MBI_LETTER = "[ac-hjkmnp-rt-y]";

const RULES: ReadonlyArray<readonly [PhiFindingCode, RegExp]> = [
  ["PLACEHOLDER", /\{\{|\}\}|<%|%>|\$\{/],
  ["EMAIL", /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/i],
  ["URL", /\b(?:https?:\/\/|www\.)\S+/i],
  // A bare host ("portal.example.org", "example.com/p/abc"): a common TLD, or any host followed by a path.
  [
    "URL",
    /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|edu|gov|io|us|info|biz|app|health|care|med)\b(?:\/\S*)?|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S+/i,
  ],
  ["IP_ADDRESS", /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
  ["SSN", /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/],
  ["PHONE", /(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\b\d{3})[\s.-]?\d{3}[\s.-]\d{4}\b/],
  [
    "DATE",
    new RegExp(
      [
        "\\b\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}\\b",
        "\\b\\d{4}-\\d{2}-\\d{2}\\b",
        `\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{2,4})?\\b`,
        `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\.?(?:,?\\s+\\d{2,4})?\\b`,
      ].join("|"),
      "i",
    ),
  ],
  [
    "IDENTIFIER_LABEL",
    new RegExp(
      "\\b(?:mrn|ssn|dob|d\\.o\\.b\\.?|medical record(?: number| no\\.?)?|member id|subscriber id|" +
        "policy(?: number| no\\.?)?|insurance id|medicare(?: id| number)?|medicaid(?: id| number)?|" +
        "patient id|account(?: number| no\\.?)|date of birth|birth ?date)\\b" +
        // a label counts only when a value follows: ":"/"#"/"=" then anything, or a token containing a digit
        "(?:\\s*[:#=]\\s*\\S|\\s+#?\\s*\\S*\\d)" +
        // or the label runs straight into its value with no separator at all ("MRN12345", "DOBAB12")
        "|\\b(?:mrn|ssn|dob)[a-z]{0,3}\\d",
      "i",
    ),
  ],
  [
    "MBI",
    new RegExp(
      `\\b[1-9]${MBI_LETTER}[ac-hjkmnp-rt-y0-9]\\d-?${MBI_LETTER}[ac-hjkmnp-rt-y0-9]\\d-?${MBI_LETTER}[ac-hjkmnp-rt-y0-9]\\d\\d\\b`,
      "i",
    ),
  ],
  [
    "STREET_ADDRESS",
    /\b\d{1,6}\s+(?:[a-z0-9.'-]+\s+){1,3}(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|court|ct|way|place|pl|terrace|circle|highway|hwy)\b/i,
  ],
  // The honorific is case-insensitive, the name must start with a capital: "Mrs. Alvarez", not "ms of latency".
  ["HONORIFIC_NAME", /\b(?:[Mm]r|[Mm]rs|[Mm]s|[Mm]iss|[Mm]x)\.?\s+\p{Lu}\p{L}/u],
];

// Zero-width, bidi and soft-hyphen characters would let "88​77..." slip past a digit rule.
const INVISIBLE = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

/** Remove zero-width, bidi and soft-hyphen characters: what is STORED and shown must be what was linted. */
export function stripInvisibleCharacters(text: string): string {
  return text.replace(INVISIBLE, "");
}

// Letters from other scripts that read as Latin ones ("\u041Crs." for "Mrs."). Applied before keyword matching.
const CONFUSABLES: Readonly<Record<string, string>> = {
  "\u0410": "A",
  "\u0412": "B",
  "\u0415": "E",
  "\u041A": "K",
  "\u041C": "M",
  "\u041D": "H",
  "\u041E": "O",
  "\u0420": "P",
  "\u0421": "C",
  "\u0422": "T",
  "\u0425": "X",
  "\u0423": "Y",
  "\u0406": "I",
  "\u0408": "J",
  "\u0405": "S",
  "\u0430": "a",
  "\u0432": "b",
  "\u0435": "e",
  "\u043A": "k",
  "\u043C": "m",
  "\u043D": "h",
  "\u043E": "o",
  "\u0440": "p",
  "\u0441": "c",
  "\u0442": "t",
  "\u0445": "x",
  "\u0443": "y",
  "\u0456": "i",
  "\u0458": "j",
  "\u0455": "s",
  "\u0391": "A",
  "\u0392": "B",
  "\u0395": "E",
  "\u0396": "Z",
  "\u0397": "H",
  "\u0399": "I",
  "\u039A": "K",
  "\u039C": "M",
  "\u039D": "N",
  "\u039F": "O",
  "\u03A1": "P",
  "\u03A4": "T",
  "\u03A5": "Y",
  "\u03A7": "X",
  "\u03BF": "o",
  "\u03B1": "a",
  "\u03BD": "v",
  "\u03C1": "p",
  "\u03C4": "t",
  "\u03B9": "i",
  "\u03BA": "k",
};
const CONFUSABLE_CHARS = new RegExp(`[${Object.keys(CONFUSABLES).join("")}]`, "g");

/** Any Unicode decimal digit (Arabic-Indic, Devanagari, ...) to its ASCII digit; NFKC alone leaves these as they are. */
function asciiDigits(text: string): string {
  return text.replace(/\p{Nd}/gu, (ch) => {
    let start = ch.codePointAt(0) as number;
    // Decimal digit runs are contiguous blocks whose length is a multiple of ten: the offset in the block is the value.
    while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start -= 1;
    return String(((ch.codePointAt(0) as number) - start) % 10);
  });
}

/** NFKC, invisible characters removed, control characters to spaces, other-script digits to ASCII. */
export function normalizeForLint(text: string): string {
  return asciiDigits(text.normalize("NFKC").replace(INVISIBLE, "").replace(CONTROL, " "));
}

/** The text the digit rules see: separators sitting between two digits ("88/77, 66 - 55") are removed. */
const collapseDigitRuns = (text: string): string => text.replace(/(?<=\d)[\s.,/-]+(?=\d)/g, "");

/** The distinct finding codes for `text`, sorted. Empty means "nothing this lint recognises", not "no PHI". */
export function lintTemplateText(text: string): PhiFindingCode[] {
  const normalized = normalizeForLint(text).replace(
    CONFUSABLE_CHARS,
    (ch) => CONFUSABLES[ch] ?? ch,
  );
  const collapsed = collapseDigitRuns(normalized);
  const found = new Set<PhiFindingCode>();
  for (const [code, pattern] of RULES) if (pattern.test(normalized)) found.add(code);
  // Six or more digits once the separators are gone, or exactly nine (an SSN written with odd separators).
  if (/\d{6,}/.test(collapsed)) found.add("LONG_NUMBER");
  if (/(?<!\d)\d{9}(?!\d)/.test(collapsed)) found.add("SSN");
  return [...found].sort();
}

/** Human wording for a finding; deliberately generic so it never repeats the text that triggered it. */
export const PHI_FINDING_MESSAGES: Readonly<Record<PhiFindingCode, string>> = {
  DATE: "looks like a date",
  EMAIL: "looks like an email address",
  HONORIFIC_NAME: "looks like a person's name (Mr., Mrs., Ms. followed by a name)",
  IDENTIFIER_LABEL: "looks like a labelled identifier (MRN, DOB, insurance or account number)",
  IP_ADDRESS: "looks like an IP address",
  LONG_NUMBER: "contains a long number that could be an identifier",
  MBI: "looks like a Medicare beneficiary identifier",
  PHONE: "looks like a phone number",
  PLACEHOLDER: "contains a merge placeholder; saved replies are plain text",
  SSN: "looks like a Social Security number",
  STREET_ADDRESS: "looks like a street address",
  URL: "contains a web address",
};
