// apps/backend/src/modules/10-hope/routes/hope-reference-screen.ts — the two operator-typed references of a submission batch.
//
// `reportReference` (a result import) and `iqiesSubmissionReference` (mark-uploaded) are free text an operator types, stored on a
// tenant-readable row and (the report reference) on every result-event row. The body schema bounds their characters
// (REFERENCE_CHARSET in hope-typebox.ts), which keeps markup and control characters out but lets "900-12-3456" or an MBI through:
// this is the patient-identifier screen every operator free text shares, run after the schema. The refusal text is static: a 422
// never echoes the value.
//
// The tokens of a CMS result row (`status`, `result`, `outcome`, `severity`, `code`, `itemCode`, `iqiesRecordId`) are typed or
// pasted by the operator too, and are stored on the item, the assessment and the result event, copied into audit row images and
// (the edit code) into the `m10.hope.submission_rejected` payload: they get the same charset and the same screen. `assessmentId`
// is not screened: it is matched against a uuid, and a uuid's hex digits trip the MBI window about once in sixty.
//
// Both the route and the service call these (a second caller of the service cannot store an identifier).
import { assertNoPatientIdentifier } from "@chartwarden/shared";

export type SubmissionReferenceField = "reportReference" | "iqiesSubmissionReference";

const refusalFor = (field: SubmissionReferenceField): string =>
  `${field} looks like it contains a patient identifier (a Social Security or Medicare number). Enter the reference that CMS or the iQIES upload gave, never a patient's number.`;

/** The result-row tokens that are screened, in the order they are looked at. A fixed list: a field name in a 422 is never the client's. */
export const RESULT_ROW_TOKEN_KEYS = [
  "status",
  "result",
  "outcome",
  "severity",
  "code",
  "itemCode",
  "iqiesRecordId",
] as const;

const resultTokenRefusal = (key: string): string =>
  `A result row's ${key} looks like it contains a patient identifier (a Social Security or Medicare number). Enter the code or id that CMS gave, never a patient's number.`;

/**
 * 422 `EVIDENCE_LOOKS_LIKE_PHI` (field `results.<row index>.<token>`) for the first token of any row that holds an SSN- or MBI-shaped
 * string. The refusal text is static and names the token, never its value.
 */
export function assertResultRowsHaveNoPatientIdentifier(
  results: readonly Record<string, unknown>[],
): void {
  results.forEach((row, index) => {
    for (const key of RESULT_ROW_TOKEN_KEYS) {
      const value = row[key];
      if (typeof value === "string" && value !== "") {
        assertNoPatientIdentifier(`results.${index}.${key}`, value, resultTokenRefusal(key));
      }
    }
  });
}

/** 422 `EVIDENCE_LOOKS_LIKE_PHI` when `value` holds an SSN- or MBI-shaped string; no value (absent, null, empty) is nothing to screen. */
export function assertReferenceHasNoPatientIdentifier(
  field: SubmissionReferenceField,
  value: string | null | undefined,
): void {
  if (value) assertNoPatientIdentifier(field, value, refusalFor(field));
}
