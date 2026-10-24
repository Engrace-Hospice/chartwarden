// apps/backend/src/modules/25-remittance/routes/medicaid-claim-facts.ts - M25 milestone 11 (11a-1): the Medicaid
// claim lookup for the case view and the payer guard. M25 does not depend on M24 in the manifest, so it reads M24
// only through the M1 seam registry (`MedicaidClaimMatchProvider`) via a structural view, the claim-match-adapter.ts
// pattern. A claim that is absent (or hidden by RLS) is null; any other failure (seam not registered, deny-stub,
// database error) is logged server-side and rethrown, so an outage is never mistaken for "no such claim".
import { getSeam } from "../../../bootstrap/index";
import type { ClaimFacts, ClaimFactsPort } from "./remittance-ports";

export interface MedicaidClaimContextView {
  readonly serviceState: string;
  readonly mcoId: string | null;
  readonly providerEntityId: string;
  readonly patientId: string;
}

/** Structural view of M24's `MedicaidClaimMatchProvider` (opaque `unknown` in the M1 registry). */
export interface MedicaidClaimFactsView {
  claimContext(orgId: string, claimId: string): Promise<MedicaidClaimContextView | null>;
}

const liveView = (): MedicaidClaimFactsView =>
  getSeam("MedicaidClaimMatchProvider") as MedicaidClaimFactsView;

/** One seam call (one M24 connection): the claim's context, null when absent. Logs (ids only, no PHI) and rethrows on failure. */
export async function medicaidClaimContext(
  organizationId: string,
  claimId: string,
  view: () => MedicaidClaimFactsView = liveView,
): Promise<MedicaidClaimContextView | null> {
  try {
    return await view().claimContext(organizationId, claimId);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "m25 medicaid claim lookup failed",
        organizationId,
        claimId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    throw error;
  }
}

/** The Medicaid {@link ClaimFactsPort} for one organization (the seam is org-keyed, the port is tx-keyed). */
export function medicaidClaimFactsPort(
  organizationId: string,
  view: () => MedicaidClaimFactsView = liveView,
): ClaimFactsPort {
  return {
    async byId(_tx, claimId): Promise<ClaimFacts | null> {
      const ctx = await medicaidClaimContext(organizationId, claimId, view);
      return ctx
        ? { id: claimId, providerEntityId: ctx.providerEntityId, patientId: ctx.patientId }
        : null;
    },
  };
}
