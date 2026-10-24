// apps/backend/src/modules/25-remittance/routes/medicaid-claim-facts.ts - M25 milestone 11 (11a-1): the Medicaid
// claim lookup for the case view. M25 does not depend on M24 in the manifest, so it reads M24 only through the M1
// seam registry (`MedicaidClaimMatchProvider`) via a structural view, the claim-match-adapter.ts pattern. Any
// failure (seam not registered, deny-stub throw, RLS rejection, claim absent) degrades to null: the claim reads as
// absent (404) - never a guessed provider entity or patient.
import { getSeam } from "../../../bootstrap/index";
import type { ClaimFacts, ClaimFactsPort } from "./remittance-ports";

/** Structural view of M24's `MedicaidClaimMatchProvider` (opaque `unknown` in the M1 registry). */
interface MedicaidClaimFactsView {
  claimContext(
    orgId: string,
    claimId: string,
  ): Promise<{ serviceState: string; mcoId: string | null; providerEntityId: string } | null>;
  patientIdForClaim(orgId: string, claimId: string): Promise<string | null>;
}

/** The Medicaid {@link ClaimFactsPort} for one organization (the seam is org-keyed, the port is tx-keyed). */
export function medicaidClaimFactsPort(
  organizationId: string,
  view: () => MedicaidClaimFactsView = () =>
    getSeam("MedicaidClaimMatchProvider") as MedicaidClaimFactsView,
): ClaimFactsPort {
  return {
    async byId(_tx, claimId): Promise<ClaimFacts | null> {
      try {
        const reader = view();
        const ctx = await reader.claimContext(organizationId, claimId);
        if (!ctx) return null;
        const patientId = await reader.patientIdForClaim(organizationId, claimId);
        return patientId
          ? { id: claimId, providerEntityId: ctx.providerEntityId, patientId }
          : null;
      } catch {
        return null;
      }
    },
  };
}
