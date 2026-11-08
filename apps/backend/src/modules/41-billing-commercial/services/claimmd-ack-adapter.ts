import { type DbClient, schema } from "@chartwarden/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { transitionForAck } from "../domain/ack-transition";
import type { CommercialOutboxPort, CommercialTx } from "./types";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** M41 owns its submission and claim mutation; the caller's transaction also writes the application ledger. */
export async function applyCommercialClaimMdReceipt(tx: Tx, outbox: CommercialOutboxPort, input: {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly locationId: string | null;
  readonly claimId: string;
  readonly submissionId: string;
  readonly attemptKey: string;
  readonly payerId: string;
  readonly pcn: string;
  readonly eventId: string;
  readonly occurredAt: Date;
}): Promise<{ readonly outcome: "applied" | "held"; readonly previousState: string | null;
  readonly newState: string | null; readonly reasonCode: string }> {
  const S = schema.commercialSubmissions;
  const C = schema.commercialClaims;
  const [sub] = await tx.select().from(S).where(and(eq(S.id, input.submissionId),
    eq(S.organizationId, input.organizationId), eq(S.providerEntityId, input.providerEntityId),
    eq(S.claimId, input.claimId), eq(S.controlNumber, input.pcn), eq(S.clearinghouseKey, "claimmd"),
    eq(S.clearinghousePayerId, input.payerId))).limit(1);
  if (!sub || sub.locationId !== input.locationId || `${sub.id}:${sub.attemptCount}` !== input.attemptKey || sub.status !== "sent")
    return { outcome: "held", previousState: null, newState: null, reasonCode: "SUBMISSION_ATTEMPT_MISMATCH" };
  const [latest] = await tx.select({ id: S.id }).from(S).where(and(eq(S.organizationId, input.organizationId),
    eq(S.claimId, input.claimId))).orderBy(desc(S.requestedAt), desc(S.id)).limit(1);
  if (latest?.id !== sub.id) return { outcome: "held", previousState: null, newState: null,
    reasonCode: "STALE_OR_FOREIGN_CLAIM" };
  const [claim] = await tx.select().from(C).where(and(eq(C.id, input.claimId),
    eq(C.organizationId, input.organizationId), eq(C.providerEntityId, input.providerEntityId),
    eq(C.claimControlNumber, input.pcn), eq(C.clearinghouseKey, "claimmd"),
    eq(C.clearinghousePayerId, input.payerId))).for("update").limit(1);
  if (!claim || claim.locationId !== input.locationId)
    return { outcome: "held", previousState: null, newState: null, reasonCode: "STALE_OR_FOREIGN_CLAIM" };
  const transition = transitionForAck(claim.state, "clearinghouse", "accepted");
  if (!transition) return { outcome: "held", previousState: claim.state, newState: claim.state,
    reasonCode: "STATE_NOT_TRANSITIONABLE" };
  const [recorded] = await tx.insert(schema.commercialAcknowledgments).values({
    organizationId: input.organizationId, providerEntityId: input.providerEntityId, locationId: input.locationId,
    claimId: input.claimId, submissionId: input.submissionId, clearinghouseKey: "claimmd", eventId: input.eventId,
    sourceRepresentation: "claimmd_normalized_api",
    stage: "clearinghouse", disposition: "accepted", reasonCodes: [], payerClaimNumber: null,
    occurredAt: input.occurredAt,
  }).onConflictDoNothing().returning({ id: schema.commercialAcknowledgments.id });
  if (!recorded) return { outcome: "held", previousState: claim.state, newState: claim.state,
    reasonCode: "ALREADY_RECORDED_BY_LEGACY" };
  await tx.update(S).set({ clearinghouseAcceptedAt: sql`coalesce(${S.clearinghouseAcceptedAt}, now())` }).where(eq(S.id, sub.id));
  await tx.update(C).set({ state: transition.to, updatedAt: input.occurredAt }).where(eq(C.id, claim.id));
  await tx.insert(schema.commercialClaimStateHistory).values({ organizationId: claim.organizationId,
    providerEntityId: claim.providerEntityId, locationId: claim.locationId, claimId: claim.id,
    fromState: claim.state, toState: transition.to, actorKind: "system", actorMembershipId: null, validationRunId: null });
  await outbox.publish(tx as CommercialTx, { eventName: transition.event, organizationId: input.organizationId,
    aggregateKind: "commercial_claim", aggregateId: claim.id,
    payload: { claimId: claim.id, submissionId: sub.id, stage: "clearinghouse", reasonCodes: [] } });
  return { outcome: "applied", previousState: claim.state, newState: transition.to, reasonCode: "CLEARINGHOUSE_RECEIPT" };
}
