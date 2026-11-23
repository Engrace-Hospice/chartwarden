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
  medicaidClaimIds(orgId: string, claimIds: readonly string[]): Promise<ReadonlySet<string>>;
  submissionEvidenceForLine(
    orgId: string,
    providerEntityId: string,
    keys: { readonly claimControlNumber: string },
  ): Promise<MedicaidSubmissionEvidenceView[]>;
}

export interface MedicaidSubmissionEvidenceView {
  readonly disposition: "SUBMISSION_UNVERIFIED" | "SUBMISSION_EVIDENCE";
  readonly claimId: string | null;
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly claimControlNumber: string;
  readonly canonicalPayerId: string | null;
  readonly programKind: string | null;
  readonly serviceState: string;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly claimState: string;
  readonly claimVersion: number;
  readonly replacesClaimId: string | null;
  readonly replacedByClaimId: string | null;
  readonly attempts: readonly {
    readonly submissionId: string | null;
    readonly attemptIndex: number;
    readonly claimVersion: number | null;
    readonly sourceAccountRef: string | null;
    readonly environment: string | null;
    readonly vendor: string;
    readonly vendorTransactionId: string | null;
    readonly payerId: string | null;
    readonly payerClassificationId: string | null;
    readonly programKind: string | null;
    readonly assignmentId: string | null;
    readonly assignmentVersion: number | null;
    readonly provenanceStatus: string;
    readonly result: string;
    readonly submittedAt: string | null;
    readonly acknowledgments: readonly {
      readonly kind: string;
      readonly outcome: string;
      readonly payerClaimControlNumber: string | null;
      readonly receivedAt: string;
    }[];
  }[];
}

const liveView = (): MedicaidClaimFactsView =>
  getSeam("MedicaidClaimMatchProvider") as MedicaidClaimFactsView;

/**
 * Server-owned claim/submission evidence; incomplete attempts remain ID-hidden and unverified. Unbound: nothing calls this
 * yet (the L5 review evaluator's `claimCandidates` reader has no implementation), so no M25 request path consumes the seam.
 */
export async function medicaidSubmissionEvidence(
  organizationId: string,
  providerEntityId: string,
  claimControlNumber: string,
  view: () => Pick<MedicaidClaimFactsView, "submissionEvidenceForLine"> = liveView,
): Promise<MedicaidSubmissionEvidenceView[]> {
  return view().submissionEvidenceForLine(organizationId, providerEntityId, { claimControlNumber });
}

/** One seam call (one M24 connection): the claim's context, null when absent. Logs (ids only, no PHI) and rethrows on failure. */
export async function medicaidClaimContext(
  organizationId: string,
  claimId: string,
  view: () => Pick<MedicaidClaimFactsView, "claimContext"> = liveView,
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

/**
 * One seam call: which of `claimIds` are this org's Medicaid claims. Display-only callers (the payer badge) must never
 * fail on an M24 outage, so a failure is logged (ids only, no PHI) and reads as "none are".
 */
export async function medicaidClaimIdSet(
  organizationId: string,
  claimIds: readonly string[],
  view: () => Pick<MedicaidClaimFactsView, "medicaidClaimIds"> = liveView,
): Promise<ReadonlySet<string>> {
  if (claimIds.length === 0) return new Set();
  try {
    return await view().medicaidClaimIds(organizationId, claimIds);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "m25 medicaid claim batch lookup failed; payer stays unknown",
        organizationId,
        claimCount: claimIds.length,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return new Set();
  }
}

/** The Medicaid {@link ClaimFactsPort} for one organization (the seam is org-keyed, the port is tx-keyed). */
export function medicaidClaimFactsPort(
  organizationId: string,
  view: () => Pick<MedicaidClaimFactsView, "claimContext"> = liveView,
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
