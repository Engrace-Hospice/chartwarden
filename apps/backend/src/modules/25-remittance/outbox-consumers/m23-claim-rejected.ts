// apps/backend/src/modules/25-remittance/outbox-consumers/m23-claim-rejected.ts — the live
// `m23.claim.rejected` → 277CA denial-worklist-seed binding (F-153/F-156, #248). `handleClaimRejected`
// (../consumers/handlers.ts) has been pure and unit-tested since M25 shipped; nothing had ever bound it —
// the registry's own reason named two blockers, both fixed one file over: `denial_case` had no unique
// index enforcing the dedupe key this handler's own header promises (migration 0249), and
// `DenialSeedStore.seedDenial` had no `taxonomyStatus` field to carry the real M38-resolved category.
//
// `m23.claim.rejected`'s catalogued payload (events-by-m23.ts) is `{claimId, acknowledgmentId,
// rejectionStage, rejectionCodes}` — no `providerEntityId`, no `occurredAt`. `occurredAt` is taken from the
// dispatcher's own envelope (`DispatchableOutboxEvent.createdAt`, the outbox row's insertion instant) — the
// closest honest proxy this consumer has, since the catalog carries no finer-grained rejection timestamp.
// `providerEntityId` is resolved via a direct read of M23's OWN `claim` table
// (`@wardenx/billing`'s `ClaimRepository.findById`) rather than a new cross-module seam: M25's manifest
// `dependsOn` already includes 23 (architecture/module-manifest.ts), and `packages/billing` is M23's own
// codePath, so importing it crosses no boundary `arch:boundaries` polices — the identical legality
// `23-billing-medicare/cost-report-seams.ts` already relies on for its own `repositories.*` reads. M23's
// published `ClaimSubmissionReader` seam (the one M25 already consumes for auto-match) does NOT expose this
// fact — `candidatesForLine` takes providerEntityId as an INPUT and `patientIdForClaim` resolves a patient,
// never a provider entity BY claim id — so this reads the repository directly rather than widening that
// seam's contract, which is outside this task's scope.
//
// TWO-PHASE, NOT FULLY ATOMIC — reported, not hidden: the seed INSERT (via {@link DenialSeedStore}) and the
// `m25.denial.opened` / `m25.taxonomy.unmapped_code_observed` publishes run in SEPARATE transactions,
// because `DenialSeedStore.seedDenial`'s existing signature (pre-dating this pass, out of scope to
// restructure) takes no `tx` parameter and commits its own — unlike `ingest/service-drizzle.ts`'s
// insert+publish, which share one transaction throughout. If the process crashes between the two, the
// `denial_case` row exists but its announcing events never fire, and a REDELIVERY of the same
// `m23.claim.rejected` event will not recover it: `handleClaimRejected` returns `null` (not `created`) on a
// redelivery against an already-seeded idempotency key, by design, so the publish step is never retried
// either. This is inherited from `DenialOpenedEmission`'s existing "the caller forwards to the outbox after
// a NEW seed" contract, not introduced here.
import { repositories } from "@wardenx/billing";
import type { DbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import {
  DENY_DENIAL_TERMINOLOGY,
  handleClaimRejected,
  type DenialSeedStore,
  type DenialTerminologyLookupPort,
} from "../consumers/handlers";
import type { WriteOutboxPort } from "../routes/write-service";

export const M23_CLAIM_REJECTED_CONSUMER = {
  eventName: "m23.claim.rejected",
  consumerName: "m25.claim-rejected-denial-seed",
} as const;

/** Structural binding (matches the dispatcher's `OutboxConsumerBinding` without importing bootstrap). */
export interface M23ClaimRejectedConsumerBinding {
  readonly consumerName: typeof M23_CLAIM_REJECTED_CONSUMER.consumerName;
  readonly consumerModule: "m25";
  readonly eventTypes: readonly [typeof M23_CLAIM_REJECTED_CONSUMER.eventName];
  handle(event: {
    readonly organizationId: string;
    readonly payload: unknown;
    readonly createdAt: Date;
  }): Promise<void>;
}

export interface M23ClaimRejectedConsumerDeps {
  readonly db: DbClient;
  readonly seedStore: DenialSeedStore;
  readonly outbox: WriteOutboxPort;
  readonly terminology?: DenialTerminologyLookupPort;
  /** Overridable for tests; defaults to a direct read of M23's `claim` table (see file header). */
  readonly resolveProviderEntityForClaim?: (
    organizationId: string,
    claimId: string,
  ) => Promise<string | null>;
}

function payloadOf(payload: unknown): { claimId: string; rejectionCodes: string[] } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const claimId = p.claimId;
  if (typeof claimId !== "string" || claimId.length === 0) {
    throw new Error(`${M23_CLAIM_REJECTED_CONSUMER.consumerName}: payload has no claimId`);
  }
  const rejectionCodes = Array.isArray(p.rejectionCodes)
    ? p.rejectionCodes.filter((c): c is string => typeof c === "string")
    : [];
  return { claimId, rejectionCodes };
}

/** Default `resolveProviderEntityForClaim` — reads M23's `claim` row directly (see file header for why a
 *  direct repository read, not a new seam, is the legal + in-scope choice here). */
async function defaultResolveProviderEntityForClaim(
  db: DbClient,
  organizationId: string,
  claimId: string,
): Promise<string | null> {
  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const claim = await new repositories.ClaimRepository(tx).findById(claimId);
    return claim?.providerEntityId ?? null;
  });
}

/** Build the live `m23.claim.rejected` consumer the composition root registers with the outbox dispatcher. */
export function buildM23ClaimRejectedConsumer(
  deps: M23ClaimRejectedConsumerDeps,
): M23ClaimRejectedConsumerBinding {
  const resolveProviderEntity =
    deps.resolveProviderEntityForClaim ??
    ((organizationId: string, claimId: string) =>
      defaultResolveProviderEntityForClaim(deps.db, organizationId, claimId));
  const terminology = deps.terminology ?? DENY_DENIAL_TERMINOLOGY;

  return {
    consumerName: M23_CLAIM_REJECTED_CONSUMER.consumerName,
    consumerModule: "m25" as const,
    eventTypes: [M23_CLAIM_REJECTED_CONSUMER.eventName] as const,
    async handle(event) {
      const { claimId, rejectionCodes } = payloadOf(event.payload);
      const organizationId = event.organizationId;

      const providerEntityId = await resolveProviderEntity(organizationId, claimId);
      if (!providerEntityId) {
        // Refuse rather than guess (the F-102 "a guessed provider entity is a mis-stated cost report"
        // discipline): `denial_case.provider_entity_id` is NOT NULL, and a rejected claim M23 does not
        // (yet, or ever, for a cross-tenant id) know about is a genuine integration defect, not a business
        // outcome — the dispatcher retries and eventually DLQs it.
        throw new Error(
          `${M23_CLAIM_REJECTED_CONSUMER.consumerName}: no M23 claim ${claimId} in org ${organizationId} ` +
            `(cannot resolve providerEntityId)`,
        );
      }

      const emission = await handleClaimRejected(
        deps.seedStore,
        {
          organizationId,
          providerEntityId,
          claimId,
          rejectionCodes,
          occurredAt: event.createdAt.toISOString(),
        },
        terminology,
      );
      if (!emission) return; // idempotent skip — already seeded (see file header, two-phase caveat)

      await withOrgContext(deps.db, { organizationId, userId: "" }, async (tx) => {
        await deps.outbox.publish(tx, {
          eventName: "m25.denial.opened",
          organizationId,
          aggregateKind: "denial_case",
          aggregateId: emission.denialCaseId,
          payload: {
            denialCaseId: emission.denialCaseId,
            providerEntityId: emission.providerEntityId,
            claimId: emission.claimId,
            carcCode: emission.carcCode,
            category: emission.category,
            source: emission.source,
            dollarValue: emission.dollarValue,
          },
        });
        if (emission.taxonomyStatus === "unmapped") {
          await deps.outbox.publish(tx, {
            eventName: "m25.taxonomy.unmapped_code_observed",
            organizationId,
            aggregateKind: "denial_case",
            aggregateId: emission.denialCaseId,
            payload: {
              carcCode: emission.carcCode,
              rarcCode: emission.rarcCode,
              providerEntityId: emission.providerEntityId,
              denialCaseId: emission.denialCaseId,
            },
          });
        }
      });
    },
  };
}
