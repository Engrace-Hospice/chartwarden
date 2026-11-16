// apps/backend/src/modules/10-hope/routes/hope-reference-screen.ts — the operator-typed text of a submission batch and of a CMS result.
//
// `reportReference` (a result import), `iqiesSubmissionReference` (mark-uploaded) and the fields of every row of a pasted CMS report
// are text an operator types or pastes, stored on tenant-readable rows, copied into audit row images (the tokens `code`, `itemCode`,
// `severity` and `iqiesRecordId` are NOT in the scrub lists) and, for the edit code and item code, into the
// `m10.hope.submission_rejected` payload (`findings[].ruleId`). Two layers keep a patient out of them:
//   1. the FORMAT: the body schema bounds characters and lengths (`HOPE_TOKEN_PATTERN` for a reference, `HOPE_RESULT_CODE_PATTERN`
//      for a code or a record id, `HOPE_RESULT_STATUS_PATTERN` for a status phrase, `HOPE_RESULT_SEVERITY_PATTERN` for a severity,
//      `HOPE_RESULT_ASSESSMENT_ID_PATTERN` for an assessment id, all in hope-typebox.ts). A reference and a token that is not a
//      phrase hold no markup, no control character and, for a code or id, no space and no slash. A `message` is prose and has no
//      pattern: it is checked here for what the database cannot store (NUL and an unpaired surrogate, which Postgres refuses in text
//      and jsonb and which would surface as a 500) and, as a policy choice, for any other control character but tab, line feed and
//      carriage return;
//   2. the CONTENT: the patient-identifier screen every operator free text shares (SSN and MBI shapes) over every text field, plus,
//      for the three code-like tokens and for an assessment id that is not a uuid, a calendar-date shape and a US phone shape (a code
//      is never either, and both identify a person together with anything else on the row). The refusal text is static: a 422 never
//      echoes the value, and the field it names is built from a fixed key list and a row index, never from the client.
// `status`, `result`, `outcome`, `message` and the two references get only the SSN and MBI screen (and the charset where there is
// one), and the severity is a closed set, so a row with another severity (`Info`) is refused and is dropped from the report.
//
// The text the screen reads is BOUNDED (`HOPE_RESULT_TEXT_BUDGET`): its cost follows the text, on the shared event loop.
//
// The route runs the schema first; the ROUTE and the SERVICE both call `assertSubmissionReferenceIsClean` and `cleanResultRows` /
// `assertResultRowsAreClean`, which re-apply the same patterns (the exported constants) and the same screens, and the service stores
// ONLY the rows `cleanResultRows` returns (schema keys, string values, a trimmed assessment id), so a second caller of the service
// cannot store what the route would refuse. The in-memory twin (routes/service.ts) calls them too.
import { assertNoPatientIdentifier } from "@chartwarden/shared";
import { ChartWardenError, ValidationError } from "@chartwarden/types";
import { canonicalUuidOrNull } from "../hope-uuid";
import {
  HOPE_REFERENCE_MAX_LENGTH,
  HOPE_RESULT_ASSESSMENT_ID_PATTERN,
  HOPE_RESULT_CODE_PATTERN,
  HOPE_RESULT_MAX_ROWS,
  HOPE_RESULT_MESSAGE_MAX_LENGTH,
  HOPE_RESULT_SEVERITY_PATTERN,
  HOPE_RESULT_STATUS_PATTERN,
  HOPE_RESULT_TOKEN_MAX_LENGTH,
  HOPE_TOKEN_PATTERN,
} from "./hope-typebox";

export type SubmissionReferenceField = "reportReference" | "iqiesSubmissionReference";

/**
 * The most text the identifier screen has to READ in one result import, in UTF-16 units summed over every row: each `message`, and
 * each `assessmentId` that is not a uuid (a uuid is not screened, so it does not count). The screen normalises text (NFKD, which
 * expands some characters up to 18 times), so its cost follows the text, and it runs on the shared event loop: 2000 rows of 1000
 * compatibility characters (about 6 MB) held the loop for seconds. Measured at this budget, per pass (the route and the service
 * each run one): 79 ms for U+FDFA, the worst expansion, 15 ms for Hangul, 3 ms for runs of combining marks (which the screen now
 * drops before the NFKD), under 1 ms for ASCII. An import over it is refused BEFORE any screen runs and is split by the operator.
 * REAL CAPACITY: the budget is shared by the messages, so about 660 rows fit at 150-character messages and about 330 at 300; the
 * 2000-row limit is reachable only when messages average 50 characters. The tokens are bounded by their own 64-character patterns.
 */
export const HOPE_RESULT_TEXT_BUDGET = 100_000;

const REFERENCE = new RegExp(HOPE_TOKEN_PATTERN);
const ASSESSMENT_ID = new RegExp(HOPE_RESULT_ASSESSMENT_ID_PATTERN);

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

/** The only keys a stored row has: what the schema's `additionalProperties: false` allows. */
const ROW_KEYS: ReadonlySet<string> = new Set([
  "assessmentId",
  "message",
  ...RESULT_ROW_TOKENS.map((token) => token.key),
]);

/** A result row as stored: only the schema's keys, each a string. */
export type CleanResultRow = Readonly<Partial<Record<string, string>>>;

/**
 * Text the database cannot store (NUL and an unpaired surrogate are refused by Postgres in text and jsonb, which would surface as
 * a 500) plus, as a POLICY choice, every other control character: an assessment id has none at all, a message keeps tab, line feed
 * and carriage return.
 */
const UNSTORABLE_ID =
  /\p{Cc}|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const UNSTORABLE_MESSAGE =
  /(?![\t\n\r])\p{Cc}|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

// A calendar date a code is never (a birth date, a visit date): YYYY-MM-DD, and the day-first or month-first spelling DD.MM.YYYY /
// MM-DD-YYYY, a 4-digit year 18xx to 20xx, not part of a longer run of digits, set apart by ANY of the separators a code may hold
// (`- . _ : #`, mixed allowed: `1990-05_17`); a slash is refused by the charset. RESIDUAL: a compact date (`19900517`, `05-17-90`)
// is no shape this can tell from a code.
const SEP = "[-._:#]";
const DATE_YEAR_FIRST = new RegExp(`(?<!\\d)(?:18|19|20)\\d{2}${SEP}\\d{1,2}${SEP}\\d{1,2}(?!\\d)`);
const DATE_YEAR_LAST = new RegExp(`(?<!\\d)\\d{1,2}${SEP}\\d{1,2}${SEP}(?:18|19|20)\\d{2}(?!\\d)`);
// A US phone number: 3-3-4 digits set apart by the same separators, with an optional leading 1. RESIDUAL: `5558675309`.
const US_PHONE = new RegExp(`(?<!\\d)(?:1${SEP})?\\d{3}${SEP}\\d{3}${SEP}\\d{4}(?!\\d)`);

/** What an assessment id's charset allows between digit groups: blanks (`\s`), braces and hyphens, in any run. */
const ID_FILLER = /[\s{}-]+/g;

const looksLikeDateOrPhone = (value: string): boolean =>
  DATE_YEAR_FIRST.test(value) || DATE_YEAR_LAST.test(value) || US_PHONE.test(value);

const refusalFor = (field: SubmissionReferenceField): string =>
  `${field} looks like it contains a patient identifier (a Social Security or Medicare number). Enter the reference that CMS or the iQIES upload gave, never a patient's number.`;

const tokenRefusal = (key: string, codeLike: boolean): string =>
  `A result row's ${key} looks like it contains a patient identifier (a Social Security or Medicare number${codeLike ? ", a date or a phone number" : ""}). Enter the ${codeLike ? "code or id" : "text"} that CMS gave, never a patient's number.`;

const messageRefusal =
  "A result row's message looks like it contains a patient identifier (a Social Security or Medicare number). Remove the patient's number from the message before recording the report.";

const assessmentIdRefusal =
  "A result row's assessmentId is not an assessment id, and looks like it contains a patient identifier (a Social Security or Medicare number, a date or a phone number). Use the assessment id from the package, never a patient's number.";

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

const tooLarge = (message: string): ValidationError =>
  new ValidationError("request validation failed", [
    { field: "results", code: "TOO_LARGE", message },
  ]);

function refuseAsPatientIdentifier(field: string, message: string): never {
  const code = "EVIDENCE_LOOKS_LIKE_PHI";
  throw new ChartWardenError(code, message, 422, [{ field, code, message }]);
}

/**
 * A submission reference (`reportReference`, `iqiesSubmissionReference`) in the schema's format (1 to `HOPE_REFERENCE_MAX_LENGTH`
 * characters of `HOPE_TOKEN_PATTERN`, first character not a space), then screened for a patient identifier: `422 VALIDATION_FAILED`
 * or `422 EVIDENCE_LOOKS_LIKE_PHI`, never echoing the value. No value (absent, null) is nothing to check. The identifier screen is the
 * only content check a reference gets (no date or phone shape: a reference is an upload or report id, not a code).
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

/**
 * The structure of the report and the row the service will store: an array of at most `HOPE_RESULT_MAX_ROWS` plain objects whose keys
 * are the schema's and whose values are strings (the schema's `additionalProperties: false` and types, which the service cannot
 * assume the route enforced), within the aggregate text budget. Nothing is screened here: the budget is checked while the rows are
 * rebuilt, so an oversized report is refused before a single identifier screen runs. Returns the rebuilt rows, the only thing a caller
 * may store, with `assessmentId` trimmed (a pasted CSV cell carries blanks). Every refusal is a static 422 naming `results.<row>`.
 */
function rebuildRows(results: unknown): CleanResultRow[] {
  if (!Array.isArray(results)) throw malformed("results");
  if (results.length > HOPE_RESULT_MAX_ROWS)
    throw tooLarge(
      `a result import takes at most ${HOPE_RESULT_MAX_ROWS} rows; split the report into several imports`,
    );
  let text = 0;
  return results.map((row: unknown, index) => {
    if (typeof row !== "object" || row === null || Array.isArray(row))
      throw malformed(`results.${index}`);
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      if (!ROW_KEYS.has(key)) throw malformed(`results.${index}`);
      if (value === undefined) continue;
      if (typeof value !== "string") throw malformed(`results.${index}.${key}`);
      out[key] = key === "assessmentId" ? value.trim() : value;
      // Only what the screen reads counts: a message, and an assessment id that is no uuid (a uuid is skipped by the screen).
      if (key === "message" || (key === "assessmentId" && canonicalUuidOrNull(out[key]) === null))
        text += value.length;
    }
    if (text > HOPE_RESULT_TEXT_BUDGET)
      throw tooLarge(
        "the report is too large to import in one request; split it into several imports",
      );
    return out;
  });
}

/** What the database cannot store in a result row's text, and the format of each field (the patterns the schema carries). */
function assertRowsAreWellFormed(rows: readonly CleanResultRow[]): void {
  rows.forEach((row, index) => {
    for (const { key, pattern } of RESULT_ROW_TOKENS) {
      const value = row[key];
      if (value === undefined) continue;
      if (value.length > HOPE_RESULT_TOKEN_MAX_LENGTH || !pattern.test(value))
        throw malformed(`results.${index}.${key}`);
    }
    // The trimmed id: a trailing CR of a CRLF-split CSV is a blank, as the importer's own lookup reads it. NUL, an unpaired surrogate
    // and any control character inside it are refused.
    const assessmentId = row.assessmentId;
    if (assessmentId !== undefined) {
      if (UNSTORABLE_ID.test(assessmentId)) throw unstorable(`results.${index}.assessmentId`);
      if (assessmentId.length > 64 || !ASSESSMENT_ID.test(assessmentId))
        throw malformed(`results.${index}.assessmentId`);
    }
    const message = row.message;
    if (message !== undefined) {
      if (message.length > HOPE_RESULT_MESSAGE_MAX_LENGTH)
        throw malformed(`results.${index}.message`);
      if (UNSTORABLE_MESSAGE.test(message)) throw unstorable(`results.${index}.message`);
    }
  });
}

/**
 * The patient-identifier screens over every field of every row. `status`, `result`, `outcome`, `message` and the references get the
 * SSN and MBI screen only (plus the charset where one exists); the three code-like tokens also refuse a date and a phone shape; the
 * closed severity set needs none.
 */
function assertRowsHaveNoPatientIdentifier(rows: readonly CleanResultRow[]): void {
  rows.forEach((row, index) => {
    for (const { key, codeLike } of RESULT_ROW_TOKENS) {
      const value = row[key];
      // A severity is one of a closed set (the schema's pattern): nothing to screen.
      if (key === "severity" || value === undefined || value === "") continue;
      // An iQIES record id may be a uuid, and a uuid's hex digits trip the MBI window about once in sixty: not screened.
      if (key === "iqiesRecordId" && canonicalUuidOrNull(value) !== null) continue;
      const field = `results.${index}.${key}`;
      assertNoPatientIdentifier(field, value, tokenRefusal(key, codeLike));
      if (codeLike && looksLikeDateOrPhone(value))
        refuseAsPatientIdentifier(field, tokenRefusal(key, codeLike));
    }
    // A uuid is the only value an assessment id should be, and the only one the MBI window false-positives on: screen the rest.
    const assessmentId = row.assessmentId;
    if (assessmentId !== undefined && canonicalUuidOrNull(assessmentId) === null) {
      const field = `results.${index}.assessmentId`;
      assertNoPatientIdentifier(field, assessmentId, assessmentIdRefusal);
      // The id's charset (hex digits, hyphens, braces, inner blanks) still holds a date or a phone number set apart by hyphens, by
      // blanks (a space, a no-break space) or by braces (`{555}{867}{5309}`): a run of blanks, braces and hyphens is read as one
      // hyphen, so each spelling meets the shapes the plainly hyphenated one does (`555 - 867 - 5309` included). Only the shape test sees it; the stored value is unchanged.
      if (looksLikeDateOrPhone(assessmentId.replace(ID_FILLER, "-")))
        refuseAsPatientIdentifier(field, assessmentIdRefusal);
    }
    const message = row.message;
    if (message !== undefined && message !== "")
      assertNoPatientIdentifier(`results.${index}.message`, message, messageRefusal);
  });
}

/**
 * Every row of a CMS result report, rebuilt and checked, and returned: structure and size first (the only rows a caller may store
 * are the rebuilt ones: schema keys only, string values, `assessmentId` trimmed), then the format of each field and what the
 * database cannot store, then the patient-identifier screens. `422 VALIDATION_FAILED` or `422 EVIDENCE_LOOKS_LIKE_PHI` with the field
 * `results.<row>.<field>` and a static message; nothing of the row is echoed. Called by the route (after the schema) and by the
 * service (which stores what this returns).
 */
export function cleanResultRows(results: unknown): CleanResultRow[] {
  const rows = rebuildRows(results);
  assertRowsAreWellFormed(rows);
  assertRowsHaveNoPatientIdentifier(rows);
  return rows;
}

/** {@link cleanResultRows} for a caller that only needs the verdict (the route, which hands the service the parsed body). */
export function assertResultRowsAreClean(results: unknown): void {
  cleanResultRows(results);
}
