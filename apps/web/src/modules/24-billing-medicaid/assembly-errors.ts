/** Map stable assembly error codes to PHI-free guidance; never expose arbitrary server details. */
export function assembleErrorMessage(status: number | undefined, payload: unknown): string {
  const envelope =
    typeof payload === "object" && payload !== null && "error" in payload
      ? (payload as { error?: { code?: unknown } }).error
      : undefined;
  const code = typeof envelope?.code === "string" ? envelope.code : undefined;

  switch (code) {
    case "MEDICAID_COVERAGE_READER_UNBOUND":
      return "Coverage records are unavailable for this service window. Confirm the coverage records and retry the preview.";
    case "MEDICAID_PAYER_RESPONSIBILITY_UNRESOLVED":
      return "Payer responsibility could not be established for this service window. Review the recorded coverage and applicable billing policy; do not change payer ranking to bypass a billing restriction.";
    case "MEDICAID_LOC_PERIOD_READER_UNBOUND":
      return "Room & Board availability is unresolved because level-of-care records are unavailable. Reconcile the clinical records or retry later.";
    case "MEDICAID_ASSEMBLY_PREVIEW_UNBOUND":
      return "The server-authoritative assembly preview is unavailable in this environment. No payer or eligibility conclusion was made.";
    case "MEDICAID_COVERAGE_NOT_IN_FORCE":
      return "No single Medicaid coverage is in force for the full service range. Correct the coverage dates or split the claim at the coverage change.";
    case "MEDICAID_COVERAGE_CHANGED":
    case "MEDICAID_PRIMARY_COVERAGE_CHANGED":
      return "Primary or Medicaid coverage changed during assembly. Reload the coverage and claim details before assembling again.";
    case "MEDICAID_COVERAGE_AMBIGUOUS":
    case "MEDICAID_PRIMARY_COVERAGE_AMBIGUOUS":
      return "Overlapping coverage makes payer responsibility unclear. Resolve the coverage overlap before assembly.";
    case "MEDICAID_PRIMARY_COVERAGE_MISSING":
      return "Primary coverage is missing or unconfirmed for this service range. Correct the coverage record before assembly.";
    case "MEDICARE_PRIMARY_HOSPICE_RESPONSIBILITY":
      return "Medicare FFS is the recorded primary coverage for this service window. This record alone does not establish Part A hospice coverage or payment responsibility; verify the applicable benefit before choosing the Medicare billing workflow.";
    case "MEDICAID_SECONDARY_RB_FORMAT_UNVERIFIED":
    case "MEDICAID_SECONDARY_COMBINED_FORMAT_UNVERIFIED":
      return "Medicaid eligibility is not denied, but the secondary Room & Board claim format is unverified. Assembly is blocked pending state-format confirmation.";
    case "MEDICAID_TPL_POLICY_UNVERIFIED":
      return "The Medicaid third-party-liability policy for this primary payer is not established. Resolve payer responsibility before assembly.";
    case "MEDICAID_TERTIARY_BILLING_UNSUPPORTED":
      return "Tertiary Medicaid billing is not supported by the current payer-responsibility policy.";
    case "MEDICAID_COVERAGE_RESOLUTION_CONFLICT":
      return "The selected Medicaid coverage conflicts with the resolved primary payer. Review the coverage records before assembly.";
    case "MEDICAID_RB_ARRANGEMENT_REQUIRED":
      return "Enter an applicable Room & Board arrangement ID before assembling this claim kind.";
    case "MEDICAID_RB_ARRANGEMENT_NOT_APPLICABLE":
      return "A hospice-only claim cannot include a Room & Board arrangement.";
    case "MEDICAID_RB_ARRANGEMENT_IDENTITY_MISMATCH":
    case "MEDICAID_RB_DAY_IDENTITY_MISMATCH":
      return "The selected Room & Board arrangement or day does not match this patient and provider. Review the arrangement assignment.";
    case "MEDICAID_RB_ARRANGEMENT_CONTRACT_UNVERIFIED":
    case "MEDICAID_RB_ARRANGEMENT_STATE_UNVERIFIED":
      return "The Room & Board arrangement is missing required contract evidence or does not have a billable state.";
    case "MEDICAID_RB_ARRANGEMENT_DATE_MISMATCH":
    case "MEDICAID_RB_ARRANGEMENT_OUTSIDE_SERVICE_RANGE":
      return "The Room & Board arrangement does not cover the selected service dates. Correct its effective dates or choose an applicable arrangement.";
    case "MEDICAID_RB_FACILITY_IDENTITY_MISSING":
      return "The Room & Board arrangement is missing its facility identity. Complete the arrangement before billing.";
    case "MEDICAID_NO_BILLABLE_RB_DAYS":
      return "No available billable Room & Board days exist for this arrangement and service range. Review the day records before continuing.";
    case "MEDICAID_RB_DAYS_ALREADY_ASSIGNED":
      return "One or more Room & Board days already belong to a claim. Reconcile that claim before assembling an overlapping range.";
    case "MEDICAID_RB_DAYS_PENDING_RECONCILIATION":
      return "One or more Room & Board days are still pending classification. Resolve those day records before assembly.";
    case "MEDICAID_RB_DAY_NOT_BILLABLE":
    case "MEDICAID_RB_DAY_SNAPSHOT_INVALID":
    case "MEDICAID_RB_DAY_LOC_SNAPSHOT_STALE":
      return "A Room & Board day has an unsupported or inconsistent billing snapshot and needs reconciliation.";
    case "MEDICAID_RB_ADMISSION_END_UNVERIFIED":
      return "The admission's effective end date is missing or conflicting. Reconcile the M6 stay before assembling Room & Board days.";
    case "MEDICAID_RB_ADMISSION_END_PENDING":
      return "A discharge is awaiting required approval. Reconcile it before assembling Room & Board days on or after its effective date.";
    case "MEDICAID_RB_DAY_OUTSIDE_ADMISSION":
      return "A Room & Board day falls on or after the effective admission end date and cannot be billed.";
    case "MEDICAID_RB_DAY_CONSUMPTION_CONFLICT":
      return "A Room & Board day changed during assembly. Reload the claim and day records before trying again.";
    case "MEDICAID_RB_DAYS_REQUIRE_RECONCILIATION":
      return "This draft still owns Room & Board days that cannot safely be released yet. Keep the draft and reconcile the affected days before abandoning it.";
    case "MEDICAID_MEDICARE_LINKAGE_UNSUPPORTED":
      return "A Medicare claim ID alone is not adjudication or payment evidence. Medicare-linked COB assembly remains unavailable.";
    case "MEDICAID_CLAIM_STRUCTURE_INVALID":
    case "MEDICAID_RB_DAY_COUNT_MISMATCH":
      return "The claim's stored line families or Room & Board snapshot do not match its claim kind. Reconcile the draft before validation.";
    case "MEDICAID_DRAFT_DELETE_UNSUPPORTED":
      return "Claim evidence is retained for audit. Use the abandon workflow; a draft that owns Room & Board days must be reconciled before it can be abandoned.";
  }

  if (status === 409)
    return "Coverage, claim state, or another assembly condition conflicts with this request. Review the current records before continuing.";
  if (status === 422) return "The service range or R&B arrangement is not valid for this patient.";
  if (status === 401 || status === 403)
    return "You lack permission to assemble claims for this entity.";
  if (status === 503)
    return "Claim assembly is unavailable — the upstream clinical readers are not bound in this environment.";
  return "The claim could not be assembled.";
}
