// apps/backend/src/modules/34-saas-tenant-platform/help/help-request-text.ts — what may be stored as a help request's free text (pure).
//
// A help message and an operator's close note are typed by a person, kept on a row both the tenant and every ChartWarden operator can
// read, and are not a place for a patient. The screen is a best-effort guard against an accident (a clinician pasting what is on the
// screen in front of them), not a defence against someone hiding an identifier:
//   * the shared SSN and MBI screen (`assertNoPatientIdentifier`, which already sees through zero-width characters);
//   * a medical-record-number screen: the label (MRN, "medical record number") followed by an identifier that holds a digit;
//   * a date-of-birth screen: a birth keyword followed by digits, or a full numeric or spelled-out date in the years 1900 to 2010
//     (a patient's birth year; a deadline or a signing date in the 2010s and 2020s is let through).
// All three refuse with 422 EVIDENCE_LOOKS_LIKE_PHI and never echo the value. Names are not recognized: no pattern finds them, and
// the control row says so.
//
// Cleaning is what the database CHECKs assume: NUL and lone surrogates are refused (Postgres text cannot hold them), control and
// FORMAT characters (zero-width and bidi overrides, `\p{Cf}`) are stripped (a display-spoofing risk in the operator console, and a way
// to split an identifier), and the length is counted in code points, as Postgres `length()` does, not in UTF-16 units.
import { assertNoPatientIdentifier } from "@chartwarden/shared";
import { ChartWardenError } from "@chartwarden/types";
import { HelpRequestError } from "./help-request-errors";

/** Every control character (`\p{Cc}`) except tab and newline, and every format character (`\p{Cf}`: zero-width, bidi). */
const STRIPPED = /[^\P{Cc}\t\n]|\p{Cf}/gu;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A medical record number: the label, then an identifier of at least three characters holding a digit ("MRN 123", "MRN-E6FB93"). */
const MRN_LABELLED =
  /\b(?:mrn|medical[\s-]*record(?:[\s-]*(?:number|no\.?|num|#))?)\b[\s:#.=-]*(?=[a-z0-9-]*\d)[a-z0-9][a-z0-9-]{2,}/iu;

const BIRTH_YEAR = "(?:19\\d{2}|20(?:0\\d|10))";
const MONTH_NAME =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DOB_PATTERNS: readonly RegExp[] = [
  // a birth keyword, then (within a few characters) a digit: "DOB 3/5/48", "date of birth: 1948", "born on the 3rd"
  /(?:\bdob\b|\bd\.o\.b\b|date\s+of\s+birth|birth\s*date|birthday|\bborn\b)[^\n]{0,24}?\d/iu,
  // MM/DD/YYYY, DD/MM/YYYY and YYYY-MM-DD with a birth year (separators / . -)
  new RegExp(
    `(?<!\\d)(?:0?[1-9]|1[0-2])[/.-](?:0?[1-9]|[12]\\d|3[01])[/.-]${BIRTH_YEAR}(?!\\d)`,
    "u",
  ),
  new RegExp(
    `(?<!\\d)(?:0?[1-9]|[12]\\d|3[01])[/.-](?:0?[1-9]|1[0-2])[/.-]${BIRTH_YEAR}(?!\\d)`,
    "u",
  ),
  new RegExp(
    `(?<!\\d)${BIRTH_YEAR}[/.-](?:0?[1-9]|1[0-2])[/.-](?:0?[1-9]|[12]\\d|3[01])(?!\\d)`,
    "u",
  ),
  // "March 3, 1948", "3 March 1948"
  new RegExp(`\\b${MONTH_NAME}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+${BIRTH_YEAR}\\b`, "iu"),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_NAME}\\.?,?\\s+${BIRTH_YEAR}\\b`, "iu"),
];

/** True when the text holds a labelled medical record number. */
export const looksLikeMrn = (text: string): boolean => MRN_LABELLED.test(text);

/** True when the text holds a birth keyword with digits, or a full date in a plausible birth year. */
export const looksLikeDateOfBirth = (text: string): boolean =>
  DOB_PATTERNS.some((pattern) => pattern.test(text));

/** 422 EVIDENCE_LOOKS_LIKE_PHI for an SSN, an MBI, an MRN or a date of birth; the value is never echoed. */
export function assertNoPatientShapes(field: string, text: string): void {
  assertNoPatientIdentifier(field, text);
  if (looksLikeMrn(text) || looksLikeDateOfBirth(text)) {
    const code = "EVIDENCE_LOOKS_LIKE_PHI";
    const message = `${field} looks like it contains a patient identifier (a Social Security, Medicare or medical record number, or a date of birth). Describe the problem without naming a patient.`;
    throw new ChartWardenError(code, message, 422, [{ field, code, message }]);
  }
}

/** The length Postgres `length()` reports: Unicode code points, not UTF-16 units. */
export const codePointLength = (text: string): number => [...text].length;

const invalid = (field: string, message: string): HelpRequestError =>
  new HelpRequestError("HELP_REQUEST_TEXT_INVALID", message, [
    { field, code: "HELP_REQUEST_TEXT_INVALID", message },
  ]);

/**
 * The text as it is stored: cleaned (NUL and lone surrogates refused, control and format characters stripped, trimmed), screened,
 * and judged `min` to `max` characters (code points) after cleaning. `field` names it in the refusal ("message", "note").
 */
export function normalizeHelpText(
  raw: unknown,
  opts: { readonly field: string; readonly min: number; readonly max: number },
): string {
  const { field, min, max } = opts;
  const text = typeof raw === "string" ? raw : "";
  if (text.includes("\u0000") || LONE_SURROGATE.test(text)) {
    throw invalid(
      field,
      `${field} must be valid text (no NUL characters or broken surrogate pairs)`,
    );
  }
  const cleaned = text.replace(STRIPPED, "").trim();
  assertNoPatientShapes(field, cleaned);
  const length = codePointLength(cleaned);
  if (length < min || length > max) {
    throw invalid(field, `${field} must be ${min} to ${max} characters`);
  }
  return cleaned;
}
