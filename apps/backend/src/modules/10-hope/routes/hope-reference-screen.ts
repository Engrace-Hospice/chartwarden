// apps/backend/src/modules/10-hope/routes/hope-reference-screen.ts — the operator-typed text of a submission batch and of a CMS result.
//
// `reportReference` (a result import), `iqiesSubmissionReference` (mark-uploaded) and the fields of every row of a pasted CMS report
// are text an operator types or pastes, stored on tenant-readable rows, copied into audit row images (the tokens `code`, `itemCode`,
// `severity` and `iqiesRecordId` are NOT in the scrub lists) and, for the edit code and item code, into the
// `m10.hope.submission_rejected` payload (`findings[].ruleId`). Two layers keep a patient out of them:
//   1. the FORMAT: the body schema bounds characters and lengths (`HOPE_TOKEN_PATTERN` for a reference, `HOPE_RESULT_CODE_PATTERN`
//      for a code or a record id, `HOPE_RESULT_STATUS_PATTERN` for a status phrase, `HOPE_RESULT_SEVERITY_PATTERN` for a severity,
//      all in hope-typebox.ts). A reference and a token that is not a phrase hold no markup, no control character and, for a code or
//      id, no space and no slash. `assessmentId` and `message` carry no pattern in the schema (a message is prose), so they are
//      checked here for what the database cannot store (a control character other than tab, line feed and carriage return in a
//      message, any in an id, or a lone surrogate: Postgres refuses NUL and unpaired surrogates in text and jsonb, which would
//      surface as a 500);
//   2. the CONTENT: the patient-identifier screen every operator free text shares (SSN and MBI shapes), plus, for the three
//      code-like tokens, a calendar-date shape and a US phone shape (a code is never either, and both identify a person together
//      with anything else on the row). The refusal text is static: a 422 never echoes the value, and the field it names is built
//      from a fixed key list and a row index, never from the client.
//
// The route runs the schema first; the ROUTE and the SERVICE both call `assertSubmissionReferenceIsClean` and
// `assertResultRowsAreClean`, which re-apply the same patterns (the exported constants) and the same screens, so a second caller of
// the service cannot store what the route would refuse.
import { assertNoPatientIdentifier } from "@chartwarden/shared";
import { ChartWardenError, ValidationError } from "@chartwarden/types";
import { canonicalUuidOrNull } from "../hope-uuid";
import {
  HOPE_REFERENCE_MAX_LENGTH,
  HOPE_RESULT_CODE_PATTERN,
  HOPE_RESULT_SEVERITY_PATTERN,
  HOPE_RESULT_STATUS_PATTERN,
  HOPE_RESULT_TOKEN_MAX_LENGTH,
  HOPE_TOKEN_PATTERN,
} from "./hope-typebox";

export type SubmissionReferenceField = "reportReference" | "iqiesSubmissionReference";

const REFERENCE = new RegExp(HOPE_TOKEN_PATTERN);

/** The row tokens, each with the pattern its schema field carries, in the order they are looked at. */
export const RESULT_ROW_TOKENS = [
  { key: "status", pattern: new RegExp(HOPE_RESULT_STATUS_PATTERN), codeLike: false },
  { key: "result", pattern: new RegExp(HOPE_RESULT_STATUS_PATTERN), codeLike: false },
  { key: "outcome", pattern: new RegExp(HOPE_RESULT_STATUS_PATTERN), codeLike: false },
  { key: "severity", pattern: new RegExp(HOPE_RESULT_SEVERITY_PATTERN), codeLike: false },
  { key: "code", pattern: new RegExp(HOPE_RESULT_CODE_PATTERN), codeLike: true },
  { key: "itemCode", pattern: new RegExp(HOPE_RESULT_CODE_PATTERN), codeLike: true },
  { key: "iqiesRecordId", pattern: new RegExp(HOPE_RESULT_CODE_PATTERN), codeLike: true },
] as const;

/** Anything the database cannot store: a control character, a lone surrogate. Tab, line feed and carriage return are allowed in a message only. */
const UNSTORABLE_ID =
  /\p{Cc}|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const UNSTORABLE_MESSAGE =
  /(?![\t\n\r])\p{Cc}|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

// A calendar date a code is never (a birth date, a visit date): YYYY-MM-DD or YYYY.MM.DD, and the day-first or month-first spelling
// DD.MM.YYYY / MM-DD-YYYY (separators `-` or `.`; slashes are refused by the charset), a 4-digit year 18xx to 20xx, not part of a
// longer run of digits.
const DATE_YEAR_FIRST = /(?<!\d)(?:18|19|20)\d{2}[-.]\d{1,2}[-.]\d{1,2}(?!\d)/;
const DATE_YEAR_LAST = /(?<!\d)\d{1,2}[-.]\d{1,2}[-.](?:18|19|20)\d{2}(?!\d)/;
// A US phone number: 3-3-4 digits set apart by `-` or `.`, with an optional leading 1.
const US_PHONE = /(?<!\d)(?:1[-.])?\d{3}[-.]\d{3}[-.]\d{4}(?!\d)/;

const looksLikeDateOrPhone = (value: string): boolean =>
  DATE_YEAR_FIRST.test(value) || DATE_YEAR_LAST.test(value) || US_PHONE.test(value);

const refusalFor = (field: SubmissionReferenceField): string =>
  `${field} looks like it contains a patient identifier (a Social Security or Medicare number). Enter the reference that CMS or the iQIES upload gave, never a patient's number.`;

const tokenRefusal = (key: string, codeLike: boolean): string =>
  `A result row's ${key} looks like it contains a patient identifier (a Social Security or Medicare number${codeLike ? ", a date or a phone number" : ""}). Enter the ${codeLike ? "code or id" : "text"} that CMS gave, never a patient's number.`;

const messageRefusal =
  "A result row's message looks like it contains a patient identifier (a Social Security or Medicare number). Remove the patient's number from the message before recording the report.";

const assessmentIdRefusal =
  "A result row's assessmentId is not an assessment id, and looks like it contains a patient identifier (a Social Security or Medicare number). Use the assessment id from the package, never a patient's number.";

const malformed = (field: string): ValidationError =>
  new ValidationError("request validation failed", [
    { field, code: "INVALID", message: `${field} is not in the accepted format` },
  ]);

const unstorable = (field: string): ValidationError =>
  new ValidationError("request validation failed", [
    {
      field,
      code: "INVALID_CHARACTERS",
      message: `${field} must not contain control characters or unpaired surrogates`,
    },
  ]);

function refuseAsPatientIdentifier(field: string, message: string): never {
  const code = "EVIDENCE_LOOKS_LIKE_PHI";
  throw new ChartWardenError(code, message, 422, [{ field, code, message }]);
}

/**
 * A submission reference (`reportReference`, `iqiesSubmissionReference`) in the schema's format (1 to `HOPE_REFERENCE_MAX_LENGTH`
 * characters of `HOPE_TOKEN_PATTERN`, first character not a space), then screened for a patient identifier: `422 VALIDATION_FAILED`
 * or `422 EVIDENCE_LOOKS_LIKE_PHI`, never echoing the value. No value (absent, null) is nothing to check.
 */
export function assertSubmissionReferenceIsClean(
  field: SubmissionReferenceField,
  value: string | null | undefined,
): void {
  if (value === null || value === undefined) return;
  if (typeof value !== "string" || value.length < 1 || value.length > HOPE_REFERENCE_MAX_LENGTH)
    throw malformed(field);
  if (!REFERENCE.test(value)) throw malformed(field);
  assertNoPatientIdentifier(field, value, refusalFor(field));
}

/** What the database cannot store in a result row's text, and the format of each token (the patterns the schema carries). */
function assertResultRowsAreWellFormed(results: readonly Record<string, unknown>[]): void {
  results.forEach((row, index) => {
    for (const { key, pattern } of RESULT_ROW_TOKENS) {
      const value = row[key];
      if (typeof value !== "string") continue;
      if (value.length > HOPE_RESULT_TOKEN_MAX_LENGTH || !pattern.test(value))
        throw malformed(`results.${index}.${key}`);
    }
    const assessmentId = row.assessmentId;
    if (typeof assessmentId === "string" && UNSTORABLE_ID.test(assessmentId))
      throw unstorable(`results.${index}.assessmentId`);
    const message = row.message;
    if (typeof message === "string" && UNSTORABLE_MESSAGE.test(message))
      throw unstorable(`results.${index}.message`);
  });
}

/** The patient-identifier screens over every field of every row. */
function assertResultRowsHaveNoPatientIdentifier(
  results: readonly Record<string, unknown>[],
): void {
  results.forEach((row, index) => {
    for (const { key, codeLike } of RESULT_ROW_TOKENS) {
      const value = row[key];
      // A severity is one of a closed set (the schema's pattern): nothing to screen.
      if (key === "severity" || typeof value !== "string" || value === "") continue;
      // An iQIES record id may be a uuid, and a uuid's hex digits trip the MBI window about once in sixty: not screened.
      if (key === "iqiesRecordId" && canonicalUuidOrNull(value) !== null) continue;
      const field = `results.${index}.${key}`;
      assertNoPatientIdentifier(field, value, tokenRefusal(key, codeLike));
      if (codeLike && looksLikeDateOrPhone(value))
        refuseAsPatientIdentifier(field, tokenRefusal(key, codeLike));
    }
    const assessmentId = row.assessmentId;
    // A uuid is the only value an assessment id should be, and the only one the MBI window false-positives on: screen the rest.
    if (typeof assessmentId === "string" && canonicalUuidOrNull(assessmentId.trim()) === null)
      assertNoPatientIdentifier(`results.${index}.assessmentId`, assessmentId, assessmentIdRefusal);
    const message = row.message;
    if (typeof message === "string" && message !== "")
      assertNoPatientIdentifier(`results.${index}.message`, message, messageRefusal);
  });
}

/**
 * Every row of a CMS result report: well-formed (what the database can store, and each token's schema pattern), then screened for a
 * patient identifier. `422 VALIDATION_FAILED` or `422 EVIDENCE_LOOKS_LIKE_PHI` with the field `results.<row>.<field>` and a static
 * message; nothing of the row is echoed. Called by the route (after the schema) and by the service.
 */
export function assertResultRowsAreClean(results: readonly Record<string, unknown>[]): void {
  assertResultRowsAreWellFormed(results);
  assertResultRowsHaveNoPatientIdentifier(results);
}
