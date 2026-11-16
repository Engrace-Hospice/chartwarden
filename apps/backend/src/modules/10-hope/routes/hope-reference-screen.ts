// apps/backend/src/modules/10-hope/routes/hope-reference-screen.ts — the two operator-typed references of a submission batch.
//
// `reportReference` (a result import) and `iqiesSubmissionReference` (mark-uploaded) are free text an operator types, stored on a
// tenant-readable row and (the report reference) on every result-event row. The body schema bounds their characters
// (REFERENCE_CHARSET in hope-typebox.ts), which keeps markup and control characters out but lets "900-12-3456" or an MBI through:
// this is the patient-identifier screen every operator free text shares, run after the schema. The refusal text is static: a 422
// never echoes the value.
import { assertNoPatientIdentifier } from "@chartwarden/shared";

export type SubmissionReferenceField = "reportReference" | "iqiesSubmissionReference";

const refusalFor = (field: SubmissionReferenceField): string =>
  `${field} looks like it contains a patient identifier (a Social Security or Medicare number). Enter the reference that CMS or the iQIES upload gave, never a patient's number.`;

/** 422 `EVIDENCE_LOOKS_LIKE_PHI` when `value` holds an SSN- or MBI-shaped string; no value (absent, null, empty) is nothing to screen. */
export function assertReferenceHasNoPatientIdentifier(
  field: SubmissionReferenceField,
  value: string | null | undefined,
): void {
  if (value) assertNoPatientIdentifier(field, value, refusalFor(field));
}
