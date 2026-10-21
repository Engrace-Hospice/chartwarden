// apps/backend/src/modules/25-remittance/outbox-consumers/m18-evv-aggregator-rejected.ts — the live
// `m18.evv.aggregator_rejected` → EVV-back-linked denial-worklist-seed binding (F-153/F-156, #248).
// `handleEvvAggregatorRejected` (../consumers/handlers.ts) has been pure and unit-tested since M25 shipped;
// nothing had ever bound it — see m23-claim-rejected.ts's header for the same two registry-named blockers
// (the missing `denial_case` dedupe constraint, migration 0249, and the missing `taxonomyStatus` field),
// both fixed there once for both consumers.
//
// `m18.evv.aggregator_rejected`'s catalogued payload (events-by-m18.ts) is `{submissionId, visitId,
// stateCode, rejectionCode, rejectionReason}` — no `providerEntityId`, and its own `rejectionCode` is a
// per-state EVV aggregator vendor code, NOT a CARC code (deliberately NOT passed through as `carcCode`
// below: `denial_case.carc_code` and M38's terminology catalog are both CMS CARC-code spaces, and a state
// aggregator's own rejection vocabulary has no established mapping into either — inventing one here would
// be exactly the "a guessed provider entity is a mis-stated cost report" mistake one field over, so this
// consumer leaves `carcCode`/`rarcCode` unset and lets `handleEvvAggregatorRejected`'s own documented
// defaults (CARC 16 / RARC N365) apply, honestly, rather than asserting a false CARC equivalence).
//
// M25's manifest `dependsOn` is `[1, 23, 36]` — NOT 18 — so `providerEntityId` cannot be resolved by a
// direct cross-module import the way m23-claim-rejected.ts resolves it from M23 (which IS a dependency).
// M18's own published `EvvAggregatorSubmissionDto`/`EvvAggregatorReferenceReader` seam (the one M24/M25 are
// explicitly documented to consume, per that interface's own doc comment) does not carry a provider entity
// either. What DOES is M17's `VisitReader.visitForEncounter(orgId, visitId)` → `VisitDto.providerEntityId` —
// a general-purpose "the visit by id" read, already a required, always-registered M1 seam (a deny-stub
// backs it even before M17 boots a real store), consumed here via `getSeam` rather than a `dependsOn` import
// — the `05-patient/outbox-consumers/m6-admission-activated.ts` / M13's `admissionSchedulingContextForOrg`
// precedent for reading a fact from a module this one has no compile-time edge to.
//
// AMBIENT REQUEST CONTEXT REQUIRED — a real, previously-undiagnosed third blocker found writing this file,
// not merely assumed working: M17's `SchedulingSeamStore.visitById` (the backing read behind
// `VisitReader.visitForEncounter`, seams/drizzle-store.ts) opens `withOrgContextFromRequest`, which THROWS
// outside an active `runWithRequestContext` scope — and a dispatcher tick delivering this event is not a
// request. A binding that simply called the seam would have caught that throw below and no-op'd (refused)
// on every single delivery — the exact "M17's SchedulingSeamStore … THROWS outside a request scope … each
// handler establishes the scope itself" shape `20-field-safety/consumers/bindings.ts` (F-118) and
// `19-oncall/consumers/bindings.ts` already document and fix for the identical M17 dependency. Fixed the
// same way: `runWithRequestContext({organizationId, userId: CONSUMER_USER_ID}, …)` wraps the seam call,
// establishing the scope `withOrgContextFromRequest` needs before `getSeam("VisitReader")` is ever invoked.
// `CONSUMER_USER_ID = ""` is the established dispatcher convention (F-102) for a system-attributed read.
//
// TWO-PHASE, NOT FULLY ATOMIC — see m23-claim-rejected.ts's header for the identical, inherited caveat
// (the seed INSERT and the outbox publish(es) run in separate transactions because `DenialSeedStore
// .seedDenial`'s pre-existing signature takes no `tx`).
import type { DbClient } from "@chartwarden/db";
import { runWithRequestContext, withOrgContext } from "@chartwarden/tenancy";
import { getSeam } from "../../../bootstrap/index";
import {
  DENY_DENIAL_TERMINOLOGY,
  type DenialSeedStore,
  type DenialTerminologyLookupPort,
  handleEvvAggregatorRejected,
} from "../consumers/handlers";
import type { WriteOutboxPort } from "../routes/write-service";

export const M18_EVV_AGGREGATOR_REJECTED_CONSUMER = {
  eventName: "m18.evv.aggregator_rejected",
  consumerName: "m25.evv-aggregator-rejected-denial-seed",
} as const;

/** Structural binding (matches the dispatcher's `OutboxConsumerBinding` without importing bootstrap). */
export interface M18EvvAggregatorRejectedConsumerBinding {
  readonly consumerName: typeof M18_EVV_AGGREGATOR_REJECTED_CONSUMER.consumerName;
  readonly consumerModule: "m25";
  readonly eventTypes: readonly [typeof M18_EVV_AGGREGATOR_REJECTED_CONSUMER.eventName];
  handle(event: { readonly organizationId: string; readonly payload: unknown }): Promise<void>;
}

export interface M18EvvAggregatorRejectedConsumerDeps {
  readonly db: DbClient;
  readonly seedStore: DenialSeedStore;
  readonly outbox: WriteOutboxPort;
  readonly terminology?: DenialTerminologyLookupPort;
  /** Overridable for tests; defaults to a `getSeam("VisitReader")` read (see file header). */
  readonly resolveProviderEntityForVisit?: (
    organizationId: string,
    visitId: string,
  ) => Promise<string | null>;
}

function payloadOf(payload: unknown): { submissionId: string; visitId: string } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const submissionId = p.submissionId;
  const visitId = p.visitId;
  if (typeof submissionId !== "string" || submissionId.length === 0) {
    throw new Error(
      `${M18_EVV_AGGREGATOR_REJECTED_CONSUMER.consumerName}: payload has no submissionId`,
    );
  }
  if (typeof visitId !== "string" || visitId.length === 0) {
    throw new Error(`${M18_EVV_AGGREGATOR_REJECTED_CONSUMER.consumerName}: payload has no visitId`);
  }
  return { submissionId, visitId };
}

/** The dispatcher's own system-attribution convention (F-102) for a consumer-driven read/write with no
 *  human actor. */
const CONSUMER_USER_ID = "";

/**
 * Default `resolveProviderEntityForVisit` — a lazily-resolved `getSeam("VisitReader")` read (see file
 * header for why this is a seam PULL, not a `dependsOn` import), wrapped in an explicit
 * `runWithRequestContext` scope (see file header — `withOrgContextFromRequest` throws without one). Any
 * failure — the seam not registered (impossible in a booted platform; it is a required seam with a
 * deny-stub fallback), a deny-stub throw (no real M17 store bound), or the visit not found — degrades to
 * `null`, never a fabricated id.
 */
async function defaultResolveProviderEntityForVisit(
  organizationId: string,
  visitId: string,
): Promise<string | null> {
  try {
    return await runWithRequestContext({ organizationId, userId: CONSUMER_USER_ID }, async () => {
      // `getSeam` resolves against the M1 registry (packages/types' `VisitReader` contract), not a
      // compile-time import of M17's own module code — the `claim-match-adapter.ts` shape one file
      // over, applied across a module boundary M25's manifest `dependsOn` does not include.
      const reader = getSeam("VisitReader");
      const visit = await reader.visitForEncounter(organizationId, visitId);
      return visit?.providerEntityId ?? null;
    });
  } catch {
    return null;
  }
}

/** Build the live `m18.evv.aggregator_rejected` consumer the composition root registers with the outbox
 *  dispatcher. */
export function buildM18EvvAggregatorRejectedConsumer(
  deps: M18EvvAggregatorRejectedConsumerDeps,
): M18EvvAggregatorRejectedConsumerBinding {
  const resolveProviderEntity =
    deps.resolveProviderEntityForVisit ?? defaultResolveProviderEntityForVisit;
  const terminology = deps.terminology ?? DENY_DENIAL_TERMINOLOGY;

  return {
    consumerName: M18_EVV_AGGREGATOR_REJECTED_CONSUMER.consumerName,
    consumerModule: "m25" as const,
    eventTypes: [M18_EVV_AGGREGATOR_REJECTED_CONSUMER.eventName] as const,
    async handle(event) {
      const { submissionId, visitId } = payloadOf(event.payload);
      const organizationId = event.organizationId;

      const providerEntityId = await resolveProviderEntity(organizationId, visitId);
      if (!providerEntityId) {
        // Refuse rather than guess — `denial_case.provider_entity_id` is NOT NULL, and a rejected
        // submission for a visit this org cannot resolve is a genuine integration defect (or a
        // cross-tenant mismatch), not a business outcome. The dispatcher retries and eventually DLQs it.
        throw new Error(
          `${M18_EVV_AGGREGATOR_REJECTED_CONSUMER.consumerName}: no M17 visit ${visitId} in org ` +
            `${organizationId} (cannot resolve providerEntityId)`,
        );
      }

      const emission = await handleEvvAggregatorRejected(
        deps.seedStore,
        { organizationId, providerEntityId, aggregatorSubmissionId: submissionId },
        terminology,
      );
      if (!emission) return; // idempotent skip — already seeded

      await withOrgContext(deps.db, { organizationId, userId: CONSUMER_USER_ID }, async (tx) => {
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
