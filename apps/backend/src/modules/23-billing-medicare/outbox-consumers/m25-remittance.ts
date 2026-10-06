import { repositories } from "@wardenx/billing";
import { withOrgContext } from "@wardenx/tenancy";
import {
  REMITTANCE_TRANSITION_BY_TOPIC,
  type RemittancePostedEvent,
  type RemittanceSkipReason,
  type RemittanceTransitionPlan,
  handleRemittancePosted,
  isRemittanceTopic,
} from "../consumers/handlers";
import {
  type BillingDb,
  type BillingWriteActor,
  type WriteOutboxPort,
  buildClaimStateService,
} from "../services/claim-state-service";
// M23's live `m25.remittance.claim_*` consumer — the 835 → claim-adjudication feedback loop (§2.4 /
// architecture §11.A, task 55). GAP-037.
//
// M25 (Remittance & Denials) has been merged, boot-bound and unconditionally publishing these four events
// at 835-posting time. M23 declared all four as forward-seam DENY-STUBS whose handler threw
// `ForwardSeamNotLandedError`, and `registerM23Consumers` skipped them by design — so no binding existed,
// every posting row sat `pending` forever, and NO claim ever left `ACK_ACCEPTED` when the MAC paid it. The
// claim worklist showed submitted-and-accepted claims indefinitely while the money had already landed.
//
// The fourth topic was also MISNAMED: M23 declared `m25.remittance.claim_adjusted`, which M25 has never
// emitted. Its reversal event is `claim_recouped` (CLP02=22, 42 CFR §424.526). Binding the old name would
// have subscribed to a topic no producer publishes.
//
// SHAPE: this is the boot-side adapter only. The decision (topic → transition, decimal → cents) is the
// PURE `handleRemittancePosted` in `../consumers/handlers`; the write is the module's own
// `ClaimStateService`, which owns reducer + `claim_state_history` append + §4.10 emission in ONE
// transaction. Event names are STRING literals — no M25 import, no new `dependsOn` edge.
import { buildClaimLineFinalizedEmissions } from "./claim-line-finalized";

export const M23_REMITTANCE_CONSUMER = {
  consumerName: "m23.m25-remittance",
  eventTypes: Object.keys(REMITTANCE_TRANSITION_BY_TOPIC),
} as const;

/**
 * The claim states each remittance transition is legal FROM (mirrors the `CLAIM_TRANSITIONS` rows the
 * reducer will accept). Used only to classify a non-applicable delivery BEFORE the reducer throws, so the
 * consumer can complete the row with a reason instead of failing it into an endless retry.
 */
const LEGAL_FROM: Readonly<Record<RemittanceTransitionPlan["transition"], readonly string[]>> = {
  remittance_paid: ["ack_accepted"],
  remittance_partial_paid: ["ack_accepted"],
  remittance_denied: ["ack_accepted"],
  remittance_recouped: ["paid", "partial_paid"],
};

/** The state each transition lands in — an already-there claim is a re-delivery, not an error. */
const LANDS_IN: Readonly<Record<RemittanceTransitionPlan["transition"], string>> = {
  remittance_paid: "paid",
  remittance_partial_paid: "partial_paid",
  remittance_denied: "denied",
  remittance_recouped: "ack_accepted",
};

export interface M23RemittanceConsumerDeps {
  readonly db: BillingDb;
  /** The catalog-validating `m23` tx publisher (the claim-state service emits §4.10 events through it). */
  readonly outbox?: WriteOutboxPort;
  /**
   * Sink for a delivery that changed nothing. A skip is a SETTLED decision — the outbox row completes —
   * so without this it would be silent. Not the DLQ path (that is a throw).
   */
  readonly onSkipped?: (info: {
    readonly reason: RemittanceSkipReason;
    readonly eventType: string;
    readonly organizationId: string;
    readonly claimId: string;
    readonly currentState?: string;
  }) => void;
}

export function buildM23RemittanceConsumer(deps: M23RemittanceConsumerDeps) {
  const claimState = buildClaimStateService(deps.db, { outbox: deps.outbox });

  return {
    consumerName: M23_REMITTANCE_CONSUMER.consumerName,
    consumerModule: "m23" as const,
    eventTypes: M23_REMITTANCE_CONSUMER.eventTypes,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly eventType: string;
      readonly payload: unknown;
    }): Promise<void> {
      // Route BEFORE opening a transaction (the M21/M33 back-ref precedent).
      if (!isRemittanceTopic(event.eventType)) return;
      const p = (event.payload ?? {}) as Partial<RemittancePostedEvent>;
      if (typeof p.claimId !== "string" || typeof p.remittanceAdviceId !== "string") return;

      await handleRemittancePosted(
        event.eventType,
        {
          ...p,
          eventId: event.id,
          organizationId: event.organizationId,
          claimId: p.claimId,
          remittanceAdviceId: p.remittanceAdviceId,
        },
        {
          async applyRemittanceTransition({ organizationId, plan }) {
            // The consumer is a machine principal: `actorKind: "consumer"` puts NULL in
            // `claim_state_history.actor_membership_id` (see `membershipForKind`) rather than a fabricated
            // membership id, and clears the D13 AI-actor guard.
            const actor: BillingWriteActor = {
              organizationId,
              userId: "",
              roles: [],
              membershipId: "",
              stepUpRecent: false,
              actorKind: "consumer",
            };
            return withOrgContext<BillingDb, { applied: boolean; skipped?: RemittanceSkipReason }>(
              deps.db,
              { organizationId, userId: "" },
              async (tx) => {
                const claim = await new repositories.ClaimRepository(tx).findById(plan.claimId);
                if (!claim || claim.organizationId !== organizationId) {
                  deps.onSkipped?.({
                    reason: "claim_not_found",
                    eventType: event.eventType,
                    organizationId,
                    claimId: plan.claimId,
                  });
                  return { applied: false, skipped: "claim_not_found" };
                }
                // Idempotent: a re-delivery, or a SECOND 835 line posting the same outcome for one claim,
                // finds the claim already where this event would put it. Completing the row is right —
                // throwing would retry a decision that is already recorded.
                if (
                  claim.state === LANDS_IN[plan.transition] &&
                  plan.transition !== "remittance_recouped"
                ) {
                  deps.onSkipped?.({
                    reason: "already_applied",
                    eventType: event.eventType,
                    organizationId,
                    claimId: plan.claimId,
                    currentState: claim.state,
                  });
                  return { applied: false, skipped: "already_applied" };
                }
                if (!LEGAL_FROM[plan.transition].includes(claim.state)) {
                  // An 835 for a claim that was never accepted, or one already replaced/voided. A real
                  // anomaly for a human — but NOT a delivery failure, so the row completes and the sink
                  // reports it instead of the dispatcher retrying it until the end of time.
                  deps.onSkipped?.({
                    reason: "transition_not_legal",
                    eventType: event.eventType,
                    organizationId,
                    claimId: plan.claimId,
                    currentState: claim.state,
                  });
                  return { applied: false, skipped: "transition_not_legal" };
                }
                await claimState.applyInTx(tx, actor, {
                  claimId: plan.claimId,
                  expectedVersion: claim.version,
                  event: plan.transition,
                  context: { remittanceAdviceId: plan.remittanceAdviceId },
                  extra: {
                    remittanceAdviceId: plan.remittanceAdviceId,
                    paidAmountCents: plan.paidAmountCents,
                    paidAt: plan.postedAt,
                    adjudicatedAt: plan.postedAt,
                    denialCodes: plan.denialCodes,
                    outcome:
                      plan.transition === "remittance_paid"
                        ? "paid"
                        : plan.transition === "remittance_partial_paid"
                          ? "partial_paid"
                          : "denied",
                  },
                });
                // GAP-077 — a paid / partially-paid claim finalizes its inpatient (0655/0656) lines: tell
                // M26's 20% cap. Same transaction as the transition, so the signal commits with the fact.
                if (
                  deps.outbox &&
                  (plan.transition === "remittance_paid" ||
                    plan.transition === "remittance_partial_paid")
                ) {
                  const lines = await new repositories.ClaimLineRepository(tx).listForClaim(
                    plan.claimId,
                  );
                  for (const emission of buildClaimLineFinalizedEmissions({
                    organizationId,
                    claimId: plan.claimId,
                    patientId: claim.patientId,
                    lines,
                    finalizedAt: plan.postedAt ?? new Date().toISOString(),
                  })) {
                    await deps.outbox.publish(tx, emission);
                  }
                }
                return { applied: true };
              },
            );
          },
        },
      );
    },
  };
}
