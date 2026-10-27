// apps/backend/src/modules/41-billing-commercial/outbox-consumers/m25-remittance.ts - the M41 consumer of the M25 835 posting events
// (ADR-0100 D8 amendment, #835): m25.remittance.claim_paid / claim_partial_paid / claim_denied move a COMMERCIAL claim to paid /
// partially_paid / denied and store the payer ICN (CLP07) the first posted line carried.
//
// M23 and M24 consume the same events; the claim id is a uuid in exactly one of the three claim tables, so each consumer finds its
// own row and settles the others' as `claim_not_found` (no double processing: M23's skip of a commercial id is correct and stays).
// claim_recouped is deliberately NOT subscribed: a recoupment is a money fact in M25's ledger, and the claim state machine has no
// "recouped" state; `paid` stays `paid` (never regress). Rules and the legal moves: domain/remittance-transition.ts.
//
// Idempotent: a redelivery finds the claim already in the outcome state (or past it) and changes nothing. The claim row is locked
// FOR UPDATE, so two lines of one advice, or a redelivery racing a first delivery, serialize.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, isNull } from "drizzle-orm";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import { type RemittanceOutcome, transitionForRemittance } from "../domain/remittance-transition";

/** A consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

/** Mirrors the commercial_claim_payer_icn_check CHECK (migration 1283): a value outside it is skipped, never a poison row. */
const PAYER_ICN_PATTERN = /^[A-Za-z0-9._ -]{1,50}$/;

const OUTCOME_BY_TOPIC: Readonly<Record<string, RemittanceOutcome>> = {
  "m25.remittance.claim_paid": "paid",
  "m25.remittance.claim_partial_paid": "partially_paid",
  "m25.remittance.claim_denied": "denied",
};

export type M41RemittanceSkipReason =
  | "claim_not_found"
  | "already_applied"
  | "transition_not_legal"
  | "payer_icn_conflict"
  | "payer_icn_invalid";

export interface M41RemittanceOutboxPort {
  publish(
    tx: DbClient,
    event: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

export interface M41RemittanceConsumerDeps {
  readonly db: DbClient;
  readonly outbox: M41RemittanceOutboxPort;
  /** A skip is a SETTLED decision (the outbox row completes), so without this it would be silent. */
  readonly onSkipped?: (info: {
    readonly reason: M41RemittanceSkipReason;
    readonly eventType: string;
    readonly organizationId: string;
    readonly claimId: string;
    readonly currentState?: string;
  }) => void;
}

const nonEmptyString = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

export function buildM41RemittanceConsumer(deps: M41RemittanceConsumerDeps): OutboxConsumerBinding {
  return {
    consumerName: "m41.m25-remittance",
    consumerModule: "m41",
    eventTypes: Object.keys(OUTCOME_BY_TOPIC),
    async handle(event: DispatchableOutboxEvent): Promise<void> {
      const outcome = OUTCOME_BY_TOPIC[event.eventType];
      if (!outcome) return;
      const p = (event.payload ?? {}) as Record<string, unknown>;
      const claimId = nonEmptyString(p.claimId);
      const remittanceAdviceId = nonEmptyString(p.remittanceAdviceId);
      if (!claimId || !remittanceAdviceId) return;
      const organizationId = event.organizationId;
      const payerIcn = nonEmptyString(p.payerIcn);
      const skip = (reason: M41RemittanceSkipReason, currentState?: string) =>
        deps.onSkipped?.({
          reason,
          eventType: event.eventType,
          organizationId,
          claimId,
          currentState,
        });

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const C = schema.commercialClaims;
          const [claim] = await tx
            .select()
            .from(C)
            .where(and(eq(C.id, claimId), eq(C.organizationId, organizationId)))
            .limit(1)
            .for("update");
          if (!claim) return skip("claim_not_found"); // a Medicare or Medicaid claim id (or another tenant's)

          const now = new Date();
          if (payerIcn) {
            if (!PAYER_ICN_PATTERN.test(payerIcn)) skip("payer_icn_invalid", claim.state);
            else if (claim.payerIcn && claim.payerIcn !== payerIcn)
              skip("payer_icn_conflict", claim.state); // first ICN wins; a change is for a person
            else if (!claim.payerIcn) {
              await tx
                .update(C)
                .set({ payerIcn, updatedAt: now })
                .where(and(eq(C.id, claimId), isNull(C.payerIcn)));
            }
          }

          if (claim.state === outcome) return skip("already_applied", claim.state);
          const to = transitionForRemittance(claim.state, outcome);
          if (!to) return skip("transition_not_legal", claim.state);

          await tx.update(C).set({ state: to, updatedAt: now }).where(eq(C.id, claimId));
          await tx.insert(schema.commercialClaimStateHistory).values({
            organizationId,
            providerEntityId: claim.providerEntityId,
            locationId: claim.locationId,
            claimId,
            fromState: claim.state,
            toState: to,
            actorKind: "system",
            actorMembershipId: null,
            validationRunId: null,
          });
          await deps.outbox.publish(tx, {
            eventName: "m41.claim.adjudicated",
            organizationId,
            aggregateKind: "commercial_claim",
            aggregateId: claimId,
            payload: { claimId, remittanceAdviceId, outcome: to },
          });
        },
      );
    },
  };
}
