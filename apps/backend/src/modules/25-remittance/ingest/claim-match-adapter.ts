// apps/backend/src/modules/25-remittance/ingest/claim-match-adapter.ts — WX-PR-012 the M25
// ClaimMatchCandidateProvider bound over M23's LIVE `ClaimSubmissionReader` seam (the M30
// consumed-seam-adapters.ts `degradeToSuppressed` precedent). ANY failure — the seam not yet registered
// (M23 boots without a db), a deny-stub throw, an RLS rejection — degrades to "no candidates" / "no
// patient id", never a fabricated match. `getSeam` resolves lazily per call, so registration order at
// boot does not matter.
import { getSeam } from "../../../bootstrap/index";
import type { MatchCandidate } from "../domain/match";
import type { ClaimMatchCandidateProvider } from "./service";

/** Structural view of M23's `ClaimSubmissionReader` (opaque `unknown` in the M1 registry). */
interface ClaimSubmissionReaderView {
  candidatesForLine(
    orgId: string,
    providerEntityId: string,
    keys: { payerIcn?: string; claimControlNumber?: string },
  ): Promise<
    Array<{
      claimId: string;
      claimControlNumber: string;
      payerClaimControlNumber: string | null;
      serviceFrom: string;
      serviceTo: string;
      totalChargeCents: number;
    }>
  >;
  patientIdForClaim(orgId: string, claimId: string): Promise<string | null>;
}

/** Build the live {@link ClaimMatchCandidateProvider} over M23's `ClaimSubmissionReader` seam. */
export function buildM23BackedClaimMatchCandidateProvider(): ClaimMatchCandidateProvider {
  return {
    async candidatesForLine(args): Promise<readonly MatchCandidate[]> {
      try {
        const reader = getSeam("ClaimSubmissionReader") as ClaimSubmissionReaderView;
        const rows = await reader.candidatesForLine(args.organizationId, args.providerEntityId, {
          payerIcn: args.payerIcn,
          claimControlNumber: args.patientControlNumber,
        });
        return rows.map(
          (r): MatchCandidate => ({
            claimId: r.claimId,
            claimControlNumber: r.claimControlNumber,
            payerIcn: r.payerClaimControlNumber ?? undefined,
            serviceFrom: r.serviceFrom,
            serviceTo: r.serviceTo,
            totalCharge: r.totalChargeCents / 100,
          }),
        );
      } catch {
        return [];
      }
    },
    async patientIdForClaim(organizationId, claimId): Promise<string | null> {
      try {
        const reader = getSeam("ClaimSubmissionReader") as ClaimSubmissionReaderView;
        return await reader.patientIdForClaim(organizationId, claimId);
      } catch {
        return null;
      }
    },
  };
}
