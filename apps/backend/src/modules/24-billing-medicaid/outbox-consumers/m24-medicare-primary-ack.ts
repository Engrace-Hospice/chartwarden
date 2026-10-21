// apps/backend/src/modules/24-billing-medicaid/outbox-consumers/m24-medicare-primary-ack.ts —
// F-165 (#248, m24 group): the m24 `handlers-unbound` group's `resolve-medicare-primary` action —
// `m23.claim.acknowledged` → AWAITING_MEDICARE_PRIMARY / FAILED_MEDICARE_PRIMARY → READY (§2.2, D5,
// §7.4). M24's own `M24_SUBSCRIPTION_MAP` (`consumers/subscription-map.ts`) has named this exact
// event for this exact action since F-140 (`resolve-medicare-primary` → `handleMedicarePrimaryAck`),
// and the module spec's own §4.11 outbox table (line 328 / 1854) and §7.4 worked example describe the
// mechanism decisively: "M23 transitions the Medicare claim to ACK_ACCEPTED; M23 emits
// `m23.claim.acknowledged`; M24's consumer... transitions AWAITING_MEDICARE_PRIMARY → READY, emits
// `m24.medicaid_claim.medicare_primary_resolved`" — already catalogued (`events-by-m24.ts`), unused
// by any caller until now.
//
// SCOPED HONESTLY, NOT FULLY PER SPEC: §7.4/D5 also describe snapshotting the Medicare-primary EOB
// context (`medicaid_claim.medicare_secondary_context_snapshot`) onto the claim at this same moment,
// read via M23's `ClaimReader.medicareSecondaryContext` seam — that seam is NOT bound anywhere in
// `routes/write-service-drizzle.ts` (no port for it exists on `buildDrizzleM24WriteService`'s
// parameter list at all; `assembleClaim` never reads it either), a real, separate cross-module
// seam-bind gap this pass does not fabricate a value for. `medicare_secondary_context_snapshot`
// stays exactly as it was — the F-121/F-127 "stays honestly null, not fabricated" pattern. Only the
// STATE TRANSITION half — real, decided, and fully expressed by the pure `medicaidClaimMachine` — is
// bound here.
//
// `m23.claim.acknowledged` fires ONLY on ACCEPTANCE (its own catalog description: "The 277CA accepted
// the claim"); the reject case is a DIFFERENT event, `m23.claim.rejected`, whose own catalog entry
// (`23-billing-medicare/events-by-m23.ts`) does NOT declare `m24` a consumer — confirmed by direct
// read, not assumed (only `m25` is declared there). So this consumer applies
// `medicare_primary_acknowledged` only, never `medicare_primary_rejected` — the FAILED_MEDICARE_PRIMARY
// path stays genuinely unbound and is reported rather than guessed at (binding it to an event M23
// never declares m24 on would be exactly the kind of unverified cross-module shortcut this arc exists
// to catch).
//
// CURRENTLY INERT IN PRODUCTION, REPORTED HONESTLY: no code path anywhere in this codebase ever
// transitions a `medicaid_claim` INTO `AWAITING_MEDICARE_PRIMARY` or `FAILED_MEDICARE_PRIMARY` —
// `await_medicare_primary` has zero callers outside the pure machine's own unit test (grepped). The
// spec's own §7.4 ("M24 transitions the claim to AWAITING_MEDICARE_PRIMARY at READY-attempt time") is
// real, decided behavior that has never been implemented on the PRODUCER side (`assembleClaim`/
// `validateClaim` never call `await_medicare_primary`). This consumer is therefore correct and will
// apply a real transition the moment that producer-side gap closes, but finds zero matching claims
// today — a separate, precisely-scoped M24-internal gap, deliberately not built here: this task binds
// the DECLARED consumer, it does not add a new producer-side trigger inside `assembleClaim`.
import { type DbClient, schema } from "@chartwarden/db";
import { medicaidClaimMachine } from "@chartwarden/medicaid-adapters";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, inArray } from "drizzle-orm";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

/** §3.3 — a consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

const M24_MEDICARE_PRIMARY_ACK_EVENT = "m23.claim.acknowledged" as const;
const M24_MEDICARE_PRIMARY_ACK_CONSUMER_NAME = "m24.m23-claim-acknowledged" as const;

/** Every `medicaid_claim.state` from which the pure machine legalizes `medicare_primary_acknowledged` —
 *  derived from the machine's own transition table (today AWAITING_MEDICARE_PRIMARY and
 *  FAILED_MEDICARE_PRIMARY) rather than a second, hand-kept list. */
const MEDICARE_PRIMARY_ACK_SOURCE_STATES = Array.from(
  new Set(
    medicaidClaimMachine.MEDICAID_CLAIM_TRANSITIONS.filter(
      (t) => t.event === "medicare_primary_acknowledged",
    ).map((t) => t.from),
  ),
) as (typeof schema.medicaidClaim.state.enumValues)[number][];

export interface MedicarePrimaryAckOutboxPort {
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

export interface MedicarePrimaryAckDeps {
  readonly db: DbClient;
  readonly outbox: MedicarePrimaryAckOutboxPort;
}

function medicareClaimIdOf(payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  const claimId = p.claimId;
  if (typeof claimId !== "string" || claimId.length === 0) {
    throw new Error(`${M24_MEDICARE_PRIMARY_ACK_CONSUMER_NAME}: payload has no claimId`);
  }
  return claimId;
}

/** M24's live `m23.claim.acknowledged` binding (§2.2 D5 / §7.4 COB auto-unblock). */
export function buildM24MedicarePrimaryAckConsumer(
  deps: MedicarePrimaryAckDeps,
): OutboxConsumerBinding {
  return {
    consumerName: M24_MEDICARE_PRIMARY_ACK_CONSUMER_NAME,
    consumerModule: "m24",
    eventTypes: [M24_MEDICARE_PRIMARY_ACK_EVENT],
    async handle(event: DispatchableOutboxEvent): Promise<void> {
      const medicareClaimId = medicareClaimIdOf(event.payload);
      const organizationId = event.organizationId;
      const C = schema.medicaidClaim;
      const SH = schema.medicaidClaimStateHistory;

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const held = await tx
            .select()
            .from(C)
            .where(
              and(
                eq(C.organizationId, organizationId),
                eq(C.medicareClaimId, medicareClaimId),
                inArray(C.state, MEDICARE_PRIMARY_ACK_SOURCE_STATES),
              ),
            );

          for (const claim of held) {
            const reduced = medicaidClaimMachine.reduce(
              claim.state,
              "medicare_primary_acknowledged",
            );
            if (reduced.error) continue; // raced past eligibility since the SELECT — skip, never force

            const now = new Date();
            await tx
              .update(C)
              .set({ state: reduced.state, updatedAt: now })
              .where(eq(C.id, claim.id));
            await tx.insert(SH).values({
              organizationId,
              medicaidClaimId: claim.id,
              fromState: claim.state,
              toState: reduced.state,
              reason: "medicare_primary_acknowledged",
              triggerSource: "consumer",
              actorMembershipId: null,
            });
            await deps.outbox.publish(tx, {
              eventName: "m24.medicaid_claim.medicare_primary_resolved",
              organizationId,
              aggregateKind: "medicaid_claim",
              aggregateId: claim.id,
              payload: {
                organizationId,
                claimId: claim.id,
                medicareClaimId,
                medicareClaimState: "ACK_ACCEPTED",
              },
            });
          }
        },
      );
    },
  };
}
