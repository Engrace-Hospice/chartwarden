// apps/backend/src/modules/25-remittance/ingest/claim-match-adapter.ts — WX-PR-012 the M25
// ClaimMatchCandidateProvider bound over M23's LIVE `ClaimSubmissionReader` seam (the M30
// consumed-seam-adapters.ts `degradeToSuppressed` precedent). ANY failure — the seam not yet registered
// (M23 boots without a db), a deny-stub throw, an RLS rejection — degrades to "no candidates" / "no
// patient id", never a fabricated match. `getSeam` resolves lazily per call, so registration order at
// boot does not matter.
//
// F-172 (#248, m24 group) adds the Medicaid sibling, `buildM24BackedClaimMatchCandidateProvider`, over
// M24's `MedicaidClaimMatchProvider` seam — same degrade posture. `service-drizzle.ts` picks between the
// two per advice by the advice's own `payerKind` discriminator (already on the wire at receive time),
// never a new matching scheme: a Medicare 835 matches only against M23's `claim` table, a Medicaid 835
// only against M24's `medicaid_claim` table.
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

/** Structural view of M24's `MedicaidClaimMatchProvider` (opaque `unknown` in the M1 registry). */
interface MedicaidClaimMatchProviderView {
  candidatesForLine(
    orgId: string,
    providerEntityId: string,
    keys: { claimControlNumber?: string },
  ): Promise<
    Array<{
      claimId: string;
      claimControlNumber: string;
      serviceFrom: string;
      serviceTo: string;
    }>
  >;
  patientIdForClaim(orgId: string, claimId: string): Promise<string | null>;
}

/**
 * F-172 (#248, m24 group) — build the live {@link ClaimMatchCandidateProvider} over M24's
 * `MedicaidClaimMatchProvider` seam, the Medicaid sibling of {@link buildM23BackedClaimMatchCandidateProvider}
 * above, routed to by `postAdvice` when the advice's `payerKind === "medicaid"`. Same fail-closed posture:
 * a deny-stub throw (M24 not registered), an RLS rejection, or any other failure degrades to "no
 * candidates" / "no patient id" — never a fabricated or cross-payer match.
 *
 * `medicaid_claim` carries no payer-assigned ICN column and NEVER stores the state Medicaid Recipient ID
 * (D12/§3.6), so only M25's `autoMatch` STRATEGY 2 (claim-control-number exact match, CLP01) can ever
 * bind a Medicaid line — `payerIcn`/`patientMemberId` are deliberately left `undefined` on every returned
 * candidate rather than fabricated, which correctly leaves strategies 1 and 3 unreachable for this payer.
 */
export function buildM24BackedClaimMatchCandidateProvider(): ClaimMatchCandidateProvider {
  return {
    async candidatesForLine(args): Promise<readonly MatchCandidate[]> {
      try {
        const reader = getSeam("MedicaidClaimMatchProvider") as MedicaidClaimMatchProviderView;
        const rows = await reader.candidatesForLine(args.organizationId, args.providerEntityId, {
          claimControlNumber: args.patientControlNumber,
        });
        return rows.map(
          (r): MatchCandidate => ({
            claimId: r.claimId,
            claimControlNumber: r.claimControlNumber,
            serviceFrom: r.serviceFrom,
            serviceTo: r.serviceTo,
          }),
        );
      } catch {
        return [];
      }
    },
    async patientIdForClaim(organizationId, claimId): Promise<string | null> {
      try {
        const reader = getSeam("MedicaidClaimMatchProvider") as MedicaidClaimMatchProviderView;
        return await reader.patientIdForClaim(organizationId, claimId);
      } catch {
        return null;
      }
    },
  };
}

/** Structural view of M41's `CommercialClaimReader` (opaque `unknown` in the M1 registry). */
interface CommercialClaimReaderView {
  candidatesForLine(
    orgId: string,
    providerEntityId: string,
    payerId: string,
    keys: { claimControlNumber?: string; payerIcn?: string },
  ): Promise<
    Array<{
      claimId: string;
      claimControlNumber: string;
      payerIcn?: string | null;
      serviceFrom: string;
      serviceTo: string;
    }>
  >;
  patientIdForClaim(orgId: string, claimId: string): Promise<string | null>;
}

/**
 * #725 (ADR-0100 D8) — the commercial sibling, routed to when the advice's `payerKind === "commercial"`.
 * Payer-keyed: the advice's `payerId` is passed through and M41 returns only claims whose plan belongs to that
 * payer, so a wrong-payer advice finds no candidate. A commercial claim carries no member id here, so CLP01
 * (claim control number exact) or CLP07 (payer ICN, stored by M41 from an earlier posted line, #835) can auto-bind;
 * everything else (member id, heuristic) is manual review. Same
 * fail-closed degrade as the Medicare/Medicaid providers; a missing `payerId` is "no candidates".
 */
export function buildM41BackedClaimMatchCandidateProvider(): ClaimMatchCandidateProvider {
  return {
    async candidatesForLine(args): Promise<readonly MatchCandidate[]> {
      if (!args.payerId) return [];
      try {
        const reader = getSeam("CommercialClaimReader") as CommercialClaimReaderView;
        const rows = await reader.candidatesForLine(
          args.organizationId,
          args.providerEntityId,
          args.payerId,
          { claimControlNumber: args.patientControlNumber, payerIcn: args.payerIcn },
        );
        return rows.map(
          (r): MatchCandidate => ({
            claimId: r.claimId,
            claimControlNumber: r.claimControlNumber,
            payerIcn: r.payerIcn ?? undefined,
            serviceFrom: r.serviceFrom,
            serviceTo: r.serviceTo,
          }),
        );
      } catch {
        return [];
      }
    },
    async patientIdForClaim(organizationId, claimId): Promise<string | null> {
      try {
        const reader = getSeam("CommercialClaimReader") as CommercialClaimReaderView;
        return await reader.patientIdForClaim(organizationId, claimId);
      } catch {
        return null;
      }
    },
  };
}
