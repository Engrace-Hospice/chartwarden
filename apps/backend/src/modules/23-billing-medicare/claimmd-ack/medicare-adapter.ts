import { canTransition, reduce, repositories } from "@chartwarden/billing";
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq } from "drizzle-orm";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
const { ClaimRepository } = repositories;

/** M23 owns the claim/submission lookup and the normalized receipt's domain transition. */
export async function applyMedicareClaimMdReceipt(
  tx: Tx,
  input: {
    readonly organizationId: string;
    readonly providerEntityId: string;
    readonly claimId: string;
    readonly submissionId: string;
    readonly attemptKey: string;
    readonly pcn: string;
    readonly occurredAt: Date;
  },
): Promise<{
  readonly outcome: "applied" | "held";
  readonly previousState: string | null;
  readonly newState: string | null;
  readonly reasonCode: string;
}> {
  const S = schema.claimSubmission;
  const C = schema.claim;
  const [submission] = await tx
    .select({ id: S.id, attemptIndex: S.attemptIndex, outcome: S.outcome })
    .from(S)
    .where(
      and(
        eq(S.id, input.submissionId),
        eq(S.organizationId, input.organizationId),
        eq(S.providerEntityId, input.providerEntityId),
        eq(S.claimId, input.claimId),
        eq(S.kind, "claim_837i"),
        eq(S.claimControlNumber, input.pcn),
      ),
    )
    .limit(1);
  if (
    !submission ||
    `${submission.id}:${submission.attemptIndex}` !== input.attemptKey ||
    submission.outcome !== "submitted"
  )
    return {
      outcome: "held",
      previousState: null,
      newState: null,
      reasonCode: "SUBMISSION_ATTEMPT_MISMATCH",
    };
  const [locked] = await tx
    .select({ id: C.id })
    .from(C)
    .where(
      and(
        eq(C.id, input.claimId),
        eq(C.organizationId, input.organizationId),
        eq(C.providerEntityId, input.providerEntityId),
        eq(C.latestSubmissionId, input.submissionId),
      ),
    )
    .for("update")
    .limit(1);
  if (!locked)
    return {
      outcome: "held",
      previousState: null,
      newState: null,
      reasonCode: "STALE_OR_FOREIGN_CLAIM",
    };
  const claims = new ClaimRepository(
    tx as unknown as ConstructorParameters<typeof ClaimRepository>[0],
  );
  const claim = await claims.findById(input.claimId);
  if (!claim || !canTransition(claim.state, "claimmd_receipt_accepted"))
    return {
      outcome: "held",
      previousState: claim?.state ?? null,
      newState: claim?.state ?? null,
      reasonCode: "STATE_NOT_TRANSITIONABLE",
    };
  const next = reduce(claim.state, "claimmd_receipt_accepted");
  if (next.error)
    return {
      outcome: "held",
      previousState: claim.state,
      newState: claim.state,
      reasonCode: "STATE_NOT_TRANSITIONABLE",
    };
  const moved = await claims.transitionToState(claim.id, claim.version, next.state, {
    clearinghouseAcceptedAt: input.occurredAt,
  });
  if (!moved.ok) throw new Error("CLAIMMD_M23_VERSION_CONFLICT");
  return {
    outcome: "applied",
    previousState: claim.state,
    newState: next.state,
    reasonCode: "CLEARINGHOUSE_RECEIPT",
  };
}
