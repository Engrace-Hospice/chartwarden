import type { MedicaidClaimKind } from "./contracts";

/**
 * The spec explicitly authorizes secondary Medicaid for the combined hospice + R&B shape. Hospice-only
 * requires primary Medicaid. R&B-only has no explicit secondary-payer authority yet, so it fails closed
 * unless Medicaid is primary until billing policy decides otherwise.
 */
export function medicaidCoverageAllowedForClaim(
  kind: MedicaidClaimKind,
  payerRank: number,
): boolean {
  return payerRank === 1 || kind === "combined_hospice_rb";
}
