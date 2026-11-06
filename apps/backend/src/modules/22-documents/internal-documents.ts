// apps/backend/src/modules/22-documents/internal-documents.ts — ADR-0109 D6 / D9: documents that are INTERNAL to the agency.
//
// M16's physician condolence letter and its discharge summary are filed on the DECEDENT's chart (that is what `patient_id` is), so the
// §4.7 caseload rule alone would admit anyone who sits on that chart — a bereavement volunteer who served the patient — and the
// `patient_facing` flag is one `PATCH /documents/:id` from the portal. An internal-only aggregate type is therefore read BY ROLE:
// the §4.7 scope-bypass roles (compliance, medical director, survey auditor, org admin, QA) and bereavement oversight. Caseload
// membership never admits, no PATCH makes one patient-facing, and the portal reader refuses it whatever `patient_facing` says.
//
// The set is derived from the renderer table's `internalOnly` descriptors (a test pins the two equal); this leaf holds the
// vocabulary so the ABAC predicate, the route scope and the portal reader import ONE definition without importing the renderer.
// Internal-only documents are also render-only: every hand write path refuses them (`assertNotInternalOnlyForWrite`).
import {
  ChartWardenError,
  type DocumentAggregateType,
  INTERNAL_ONLY_DOCUMENT_AGGREGATE_TYPES,
} from "@chartwarden/types";

/** The aggregate types that are internal-only (one definition in `@chartwarden/types`; M25's payer-enclosure rule reads it too). */
export { INTERNAL_ONLY_DOCUMENT_AGGREGATE_TYPES };

/** True for an internal-only aggregate type. An absent or unknown type is not internal (the real loaders always supply one). */
export const isInternalOnlyAggregateType = (aggregateType: string | null | undefined): boolean =>
  aggregateType !== null &&
  aggregateType !== undefined &&
  INTERNAL_ONLY_DOCUMENT_AGGREGATE_TYPES.has(aggregateType as DocumentAggregateType);

/**
 * Bereavement oversight roles that read internal documents in addition to the §4.7 scope-bypass roles (M22 `dependsOn` stays [1, 5],
 * so these are the role KEYS M16's `BEREAVEMENT_OVERSIGHT_ROLES` names, mirrored here; `compliance_officer` is already scope-bypass).
 */
export const INTERNAL_DOCUMENT_OVERSIGHT_ROLES: readonly string[] = [
  "clinical_supervisor",
  "director_of_nursing",
  "bereavement_coordinator",
];

/** A PATCH may not make an internal-only document patient-facing: 422 `DOCUMENT_INTERNAL_ONLY`. */
export function assertNotInternalOnlyForPatientFacing(
  aggregateType: string | null | undefined,
): void {
  if (isInternalOnlyAggregateType(aggregateType)) {
    throw new ChartWardenError(
      "DOCUMENT_INTERNAL_ONLY",
      "this document is internal to the agency and cannot be made patient-facing",
      422,
    );
  }
}

/**
 * An internal-only document is RENDER-ONLY: M22's renderer is the only writer. A hand write (a PATCH, a tag, a link, a new version, an
 * upload filed under an internal aggregate type, or `attachToDisclosures`) is refused 422 `DOCUMENT_INTERNAL_ONLY`, so none of them can
 * rewrite the letter, retag it into a caseload query or widen where it travels.
 */
export function assertNotInternalOnlyForWrite(aggregateType: string | null | undefined): void {
  if (isInternalOnlyAggregateType(aggregateType)) {
    throw new ChartWardenError(
      "DOCUMENT_INTERNAL_ONLY",
      "this document is internal to the agency and render-only: it cannot be created or changed by hand",
      422,
    );
  }
}
