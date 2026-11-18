/** Map stable assembly error codes to PHI-free guidance; never expose arbitrary server details. */
export function assembleErrorMessage(status: number | undefined, payload: unknown): string {
  const envelope =
    typeof payload === "object" && payload !== null && "error" in payload
      ? (payload as { error?: { code?: unknown } }).error
      : undefined;
  const code = typeof envelope?.code === "string" ? envelope.code : undefined;

  switch (code) {
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
      return "Medicare is primary for hospice-covered services. Assemble those services through Medicare billing.";
    case "MEDICAID_SECONDARY_RB_FORMAT_UNVERIFIED":
    case "MEDICAID_SECONDARY_COMBINED_FORMAT_UNVERIFIED":
      return "Medicaid eligibility is not denied, but the secondary Room & Board claim format is unverified. Assembly is blocked pending state-format confirmation.";
    case "MEDICAID_TPL_POLICY_UNVERIFIED":
      return "The Medicaid third-party-liability policy for this primary payer is not established. Resolve payer responsibility before assembly.";
    case "MEDICAID_TERTIARY_BILLING_UNSUPPORTED":
      return "Tertiary Medicaid billing is not supported by the current payer-responsibility policy.";
    case "MEDICAID_COVERAGE_RESOLUTION_CONFLICT":
      return "The selected Medicaid coverage conflicts with the resolved primary payer. Review the coverage records before assembly.";
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
