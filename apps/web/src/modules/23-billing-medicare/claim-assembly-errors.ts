// The M23 assemble error envelope (§4.2 codes) → a precise, PHI-free, actionable inline message.
// Every code `POST /api/v1/billing/claims/assemble` can return has an entry; only a code this table does
// not know falls back to the status-based generic text.

const ASSEMBLE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  NON_MEDICARE_PRIMARY_PAYER:
    "This patient's primary payer is not Medicare (D15) — a Medicare claim cannot be assembled. A commercial primary payer is billed under Billing - Commercial.",
  MEDICARE_ADVANTAGE_NEEDS_ORIGINAL_MEDICARE_COVERAGE:
    "This patient is a Medicare Advantage enrollee. Hospice is billed to the Medicare contractor as an Original Medicare claim: record the patient's Original Medicare (medicare_ffs) coverage with the MBI as the primary coverage, alongside the Medicare Advantage row, then retry.",
  PATIENT_NOT_ELECTED: "No active Medicare hospice election covers this service-date range.",
  PATIENT_DECEASED_BEFORE_FROM:
    "The patient's date of death precedes the claim's service-from date.",
  OVERLAPPING_ACTIVE_CLAIM: "An active claim already covers part of this service-date range.",
  ASSEMBLY_VALIDATION_FAILED:
    "Assembly validation failed — review the elected periods and dates, then retry.",
  VALIDATION_FAILED: "The service-to date is before the service-from date — correct the range.",
  PROVIDER_ENTITY_UNRESOLVED:
    "The admission's provider entity could not be found in this organization — check the admission's provider entity (Admissions → admission detail) and retry.",
  MAC_SUBMITTER_CREDENTIAL_MISSING:
    "This provider entity has no MAC submitter credential on file, so its MAC jurisdiction is unknown. Add it under Billing → MAC Credentials (billing administrators), then retry.",
  WAGE_INDEX_UNAVAILABLE:
    "No wage-index factor is on file for this provider's CCN and fiscal year. A billing administrator must enter it, then retry.",
  RATE_TABLE_MISSING:
    "No hospice rate table covers this service date. A billing administrator must enter the CMS per-diem rates for that fiscal year, then retry.",
  RATE_TABLE_LABOR_SHARE_MISSING:
    "The effective hospice rate table has no labor shares. A billing administrator must supersede it with the CMS-published labor shares, then retry.",
  SEQUESTRATION_POLICY_UNAVAILABLE:
    "No Medicare sequestration policy covers this service date. Enter it under Billing → Sequestration Policy, then retry.",
  CHC_HOURS_UNPRICEABLE:
    "Continuous home care hours in this range cannot be priced — review the continuous-care documentation for the period.",
  AI_ACTOR_FORBIDDEN: "Claims must be assembled by a person; an AI actor may not assemble claims.",
  SEAM_UNBOUND:
    "Billing assembly is unavailable — a required data source is not connected in this environment.",
};

export function assembleErrorMessage(code: string | undefined, status: number | undefined): string {
  const known = code === undefined ? undefined : ASSEMBLE_ERROR_MESSAGES[code];
  if (known !== undefined) return known;
  if (status === 503)
    return "Billing assembly is unavailable — the assembly seam is not bound, or you lack scope.";
  if (status === 403) return "You do not have scope to assemble claims for this provider entity.";
  return "The claim could not be assembled. Check the inputs and try again.";
}
