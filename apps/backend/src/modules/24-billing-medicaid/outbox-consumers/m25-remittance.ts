// apps/backend/src/modules/24-billing-medicaid/outbox-consumers/m25-remittance.ts — F-172 (#248, m24
// group): the `mark-claim-paid` / `mark-claim-denied` actions M24's own `M24_SUBSCRIPTION_MAP`
// (`consumers/subscription-map.ts`) has named since F-140, with real handlers (`handleClaimPaid`/
// `handleClaimDenied`) that had no `M24ConsumerStore` implementation anywhere — the deferred-consumer
// group's own reason. This file is the LIVE `OutboxConsumerBinding` (the F-165 `m24-revalidate-triggers.ts`
// / `m24-medicare-primary-ack.ts` shape, not `handlers.ts` + `consumers/index.ts`'s dead
// `registerM24Consumers` scaffolding).
//
// M23's sibling consumer (`23-billing-medicare/outbox-consumers/m25-remittance.ts`, GAP-037) is the exact
// template: same two events, same version-guarded write, same skip-not-throw posture for a settled
// non-applicable delivery. Both `m25.remittance.claim_paid` / `.claim_denied` already declare BOTH `m23`
// and `m24` as consumers (`25-remittance/events-by-m25.ts`) — `buildOutboxRoutingPlan` delivers to every
// BOUND consumer regardless of what else is declared (the F-139/m31 precedent), so binding this alongside
// M23's existing consumer does not interrupt Medicare's delivery, and a Medicaid claim id never resolves
// against M23's `claim` table (`claim_not_found`) the same way a Medicare claim id never resolves here.
//
// ONLY `remittance_paid` / `remittance_denied` are handled — `medicaid_claim_state` has no
// `remittance_partial_paid` counterpart in `MEDICAID_CLAIM_TRANSITIONS` and `m25.remittance
// .claim_partial_paid` / `.claim_recouped` declare only `m23` (never `m24`), so those two topics are not
// subscribed here at all — matching the catalog exactly, not merely a subset of M23's four.
import { type DbClient, schema } from "@chartwarden/db";
import { medicaidClaimMachine } from "@chartwarden/medicaid-adapters";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

/** §3.3 — a consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

type MedicaidClaimState = (typeof schema.medicaidClaim.state.enumValues)[number];

const M24_REMITTANCE_TRANSITION_BY_TOPIC = {
  "m25.remittance.claim_paid": "remittance_paid",
  "m25.remittance.claim_denied": "remittance_denied",
} as const;

type M24RemittanceTopic = keyof typeof M24_REMITTANCE_TRANSITION_BY_TOPIC;
type M24RemittanceTransitionEvent = (typeof M24_REMITTANCE_TRANSITION_BY_TOPIC)[M24RemittanceTopic];

function isM24RemittanceTopic(topic: string): topic is M24RemittanceTopic {
  return topic in M24_REMITTANCE_TRANSITION_BY_TOPIC;
}

/** Derived from the machine's own transition table (never a second, hand-kept map) — the F-165
 *  `MEDICARE_PRIMARY_ACK_SOURCE_STATES` precedent one file over. Both events have exactly one `to`. */
function landsInFor(event: M24RemittanceTransitionEvent): MedicaidClaimState {
  const found = medicaidClaimMachine.MEDICAID_CLAIM_TRANSITIONS.find((t) => t.event === event);
  if (!found) {
    throw new Error(`m24.m25-remittance: no transition table entry for "${event}"`);
  }
  return found.to;
}

/** Parse an X12 decimal-string amount ("1234.56") to integer cents. `undefined`/blank/non-finite → 0. */
function decimalToCents(amount: string | undefined): number {
  if (amount === undefined || amount.trim() === "") return 0;
  const parsed = Number(amount);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

/** Why a delivered remittance event changed nothing (a settled decision, not a delivery failure). */
export type M24RemittanceSkipReason =
  | "claim_not_found"
  | "already_applied"
  | "transition_not_legal";

export interface M24RemittanceOutboxPort {
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

export interface M24RemittanceConsumerDeps {
  readonly db: DbClient;
  readonly outbox: M24RemittanceOutboxPort;
  /** A skip is a SETTLED decision (re-delivery, unmatched claim, or a transition not legal from the
   *  claim's current state) — the outbox row completes, so without this it would be silent. */
  readonly onSkipped?: (info: {
    readonly reason: M24RemittanceSkipReason;
    readonly eventType: string;
    readonly organizationId: string;
    readonly claimId: string;
    readonly currentState?: MedicaidClaimState;
  }) => void;
}

function payloadStringOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function payloadCarcCodes(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((c): c is string => typeof c === "string") : [];
}

/** M24's live `m25.remittance.claim_paid` / `.claim_denied` binding (§2.2 D5, the M25 835-post feedback
 *  loop — the Medicaid sibling of M23's own GAP-037 consumer). */
export function buildM24RemittanceConsumer(deps: M24RemittanceConsumerDeps): OutboxConsumerBinding {
  return {
    consumerName: "m24.m25-remittance",
    consumerModule: "m24",
    eventTypes: Object.keys(M24_REMITTANCE_TRANSITION_BY_TOPIC),
    async handle(event: DispatchableOutboxEvent): Promise<void> {
      // Route BEFORE opening a transaction (the M21/M33 back-ref precedent).
      if (!isM24RemittanceTopic(event.eventType)) return;
      const p = (event.payload ?? {}) as Record<string, unknown>;
      const claimId = payloadStringOrUndefined(p.claimId);
      const remittanceAdviceId = payloadStringOrUndefined(p.remittanceAdviceId);
      if (!claimId || !remittanceAdviceId) return;

      const organizationId = event.organizationId;
      const transitionEvent = M24_REMITTANCE_TRANSITION_BY_TOPIC[event.eventType];
      const landsIn = landsInFor(transitionEvent);

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const C = schema.medicaidClaim;
          const SH = schema.medicaidClaimStateHistory;

          const rows = await tx
            .select()
            .from(C)
            .where(and(eq(C.id, claimId), eq(C.organizationId, organizationId)))
            .limit(1);
          const claim = rows[0];
          if (!claim) {
            // M25 matched this claim against a DIFFERENT payer's table (Medicare) or another tenant's row —
            // a settled non-applicable delivery, not an error. M23's own consumer is the one that will (or
            // already did) act on it.
            deps.onSkipped?.({
              reason: "claim_not_found",
              eventType: event.eventType,
              organizationId,
              claimId,
            });
            return;
          }
          if (claim.state === landsIn) {
            // A re-delivery, or a second 835 line posting the same outcome for one claim — already recorded.
            deps.onSkipped?.({
              reason: "already_applied",
              eventType: event.eventType,
              organizationId,
              claimId,
              currentState: claim.state,
            });
            return;
          }
          const reduced = medicaidClaimMachine.reduce(claim.state, transitionEvent);
          if (reduced.error) {
            // An 835 for a claim that was never accepted, or one already replaced/voided/paid-then-appealed
            // out of ACK_ACCEPTED. A real anomaly for a human, not a delivery failure — the row completes.
            deps.onSkipped?.({
              reason: "transition_not_legal",
              eventType: event.eventType,
              organizationId,
              claimId,
              currentState: claim.state,
            });
            return;
          }

          const now = new Date();
          // CAS on the version this read saw (the M23 sibling consumer's `claimRepo.transitionToState`
          // precedent) — a concurrent writer (another redelivery, or a human voiding the claim) between the
          // read above and this write loses the race and must retry against fresh state rather than
          // silently clobbering it or double-emitting `m24.medicaid_claim.paid`/`.denied`.
          const [updated] = await tx
            .update(C)
            .set({ state: reduced.state, version: claim.version + 1, updatedAt: now })
            .where(and(eq(C.id, claimId), eq(C.version, claim.version)))
            .returning({ id: C.id });
          if (!updated) {
            throw new Error(
              `m24.m25-remittance: version conflict updating medicaid_claim ${claimId} (expected version ${claim.version}) — retrying`,
            );
          }
          await tx.insert(SH).values({
            organizationId,
            medicaidClaimId: claimId,
            fromState: claim.state,
            toState: reduced.state,
            reason: transitionEvent,
            triggerSource: "consumer",
            actorMembershipId: null,
          });

          if (transitionEvent === "remittance_paid") {
            const paidAt = payloadStringOrUndefined(p.postedAt) ?? now.toISOString();
            await deps.outbox.publish(tx, {
              eventName: "m24.medicaid_claim.paid",
              organizationId,
              aggregateKind: "medicaid_claim",
              aggregateId: claimId,
              payload: {
                organizationId,
                claimId,
                remittanceAdviceId,
                paidAmountCents: decimalToCents(payloadStringOrUndefined(p.paidAmount)),
                paidAt,
              },
            });
          } else {
            await deps.outbox.publish(tx, {
              eventName: "m24.medicaid_claim.denied",
              organizationId,
              aggregateKind: "medicaid_claim",
              aggregateId: claimId,
              payload: {
                organizationId,
                claimId,
                remittanceAdviceId,
                denialCodes: payloadCarcCodes(p.carcCodes),
              },
            });
          }
        },
      );
    },
  };
}
