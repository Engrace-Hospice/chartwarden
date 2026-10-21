// apps/backend/src/modules/18-evv/jobs/submission-prep.ts — the §4.8 `m18.aggregator-submission-prep` worker
// (GAP-056): an outbox consumer of M18's OWN `m18.evv.check_out_recorded` (D11 — the aggregator handoff is
// outbox-only; no route handler ever creates a submission).
//
// THE FINDING. No code inserted `evv_aggregator_submission` rows, so `dispatchSubmission` / `pollSubmissionOnce`
// had nothing to act on and the Cures Act path could not start.
//
// WHAT IT DOES for each paired check-out: resolve the visit's state (M1 via the facts port), skip when the state
// needs no aggregator (open-model-no-aggregator, or no state configured — a no-op, not an error), else insert ONE
// `queued` submission row for (state, visit) carrying the event-pair hash. The submitter drains it. The payload is
// NOT persisted here: `payload_cipher` is DEK-envelope-encrypted by contract and that pipeline is not built, so
// the submitter rebuilds the payload from live facts at submit time (same deterministic idempotency key).
//
// IDEMPOTENCY / CORRECTION-OF-RECORD (D7 alternative (c)). A redelivery finds the row with the same pair hash and
// does nothing. A correction changes an event id, hence the hash: a still-pending/queued row is re-pointed at the
// new pair; a `rejected`/`timeout` row is requeued for the new pair (attempt counted); an `accepted` row is left
// alone (the vendor already holds the old pair — a re-submission of a corrected, accepted pair is NOT built).
import { type DbClient, schema } from "@chartwarden/db";
import { eventPairHash } from "@chartwarden/evv-aggregators";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, eq, ne } from "drizzle-orm";
import { transitionAggregatorSubmission } from "../domain/aggregator-submission";
import { type EvvAggregatorDeps, adapterFor } from "./ports";

const AGG = schema.evvAggregatorSubmission;
const REGISTRATION = schema.evvVisitRegistrations;

export const M18_SUBMISSION_PREP_CONSUMER = {
  eventName: "m18.evv.check_out_recorded",
  consumerName: "m18.aggregator-submission-prep",
} as const;

export type SubmissionPrepOutcome =
  | "queued"
  | "requeued_for_corrected_pair"
  | "repointed"
  | "already_prepared"
  | "no_pair"
  | "no_state"
  | "no_aggregator_required"
  | "left_accepted";

interface CheckOutFacts {
  readonly visitId: string;
  readonly checkOutEventId: string;
  readonly checkInEventId: string | null;
}

function factsOf(payload: unknown): CheckOutFacts {
  const p = (payload ?? {}) as Record<string, unknown>;
  const name = M18_SUBMISSION_PREP_CONSUMER.consumerName;
  const visitId = p.visitId;
  const checkOutEventId = p.eventId;
  if (typeof visitId !== "string" || visitId.length === 0) {
    throw new Error(`${name}: payload has no visitId`);
  }
  if (typeof checkOutEventId !== "string" || checkOutEventId.length === 0) {
    throw new Error(`${name}: payload has no eventId`);
  }
  const paired = p.pairedCheckInEventId;
  if (paired !== null && paired !== undefined && typeof paired !== "string") {
    throw new Error(`${name}: pairedCheckInEventId must be a string or null`);
  }
  return { visitId, checkOutEventId, checkInEventId: typeof paired === "string" ? paired : null };
}

/** Prepare (or no-op) the aggregator submission for one check-out. Exported for the live suite. */
export async function prepareAggregatorSubmission(
  db: DbClient,
  deps: EvvAggregatorDeps,
  organizationId: string,
  facts: CheckOutFacts,
): Promise<SubmissionPrepOutcome> {
  if (facts.checkInEventId === null) return "no_pair";

  const registration = await withOrgContext(db, { organizationId, userId: "" }, async (raw) => {
    const [row] = await (raw as DbClient)
      .select({ providerEntityId: REGISTRATION.providerEntityId })
      .from(REGISTRATION)
      .where(
        and(
          eq(REGISTRATION.organizationId, organizationId),
          eq(REGISTRATION.visitId, facts.visitId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
  if (!registration) {
    throw new Error(
      `${M18_SUBMISSION_PREP_CONSUMER.consumerName}: visit ${facts.visitId} has no EVV registration in this org`,
    );
  }

  const stateCode = await deps.facts.stateCodeForProviderEntity(
    organizationId,
    registration.providerEntityId,
  );
  if (stateCode === null) return "no_state";
  const adapter = adapterFor(deps.registry, stateCode);
  if (adapter === null) return "no_aggregator_required";

  const pairHash = eventPairHash(facts.checkInEventId, facts.checkOutEventId);
  return withOrgContext(db, { organizationId, userId: "" }, async (raw) => {
    const tx = raw as DbClient;
    const [inserted] = await tx
      .insert(AGG)
      .values({
        organizationId,
        visitId: facts.visitId,
        checkInEventId: facts.checkInEventId,
        checkOutEventId: facts.checkOutEventId,
        eventPairHash: pairHash,
        stateCode,
        aggregatorVendor: adapter.vendor,
        status: "queued",
      })
      .onConflictDoNothing()
      .returning({ id: AGG.id });
    if (inserted) return "queued";
    return reconcileExisting(tx, organizationId, facts, stateCode, pairHash);
  });
}

async function reconcileExisting(
  tx: DbClient,
  organizationId: string,
  facts: CheckOutFacts,
  stateCode: string,
  pairHash: string,
): Promise<SubmissionPrepOutcome> {
  const [existing] = await tx
    .select()
    .from(AGG)
    .where(
      and(
        eq(AGG.organizationId, organizationId),
        eq(AGG.visitId, facts.visitId),
        eq(AGG.stateCode, stateCode),
        ne(AGG.status, "cancelled"),
      ),
    )
    .limit(1);
  if (!existing) return "already_prepared"; // cancelled between insert-conflict and read; the next delivery retries
  if (existing.eventPairHash === pairHash) return "already_prepared";
  if (existing.status === "accepted") return "left_accepted";

  const pairColumns = {
    checkInEventId: facts.checkInEventId,
    checkOutEventId: facts.checkOutEventId,
    eventPairHash: pairHash,
    updatedAt: new Date(),
    version: existing.version + 1,
  };
  if (existing.status === "rejected" || existing.status === "timeout") {
    const t = transitionAggregatorSubmission(existing.status, { type: "resubmit" });
    await tx
      .update(AGG)
      .set({
        ...pairColumns,
        status: t.status,
        attemptCount: 0,
        nextRetryAt: null,
        aggregatorRejectionCode: null,
        aggregatorRejectionReason: null,
      })
      .where(and(eq(AGG.id, existing.id), eq(AGG.version, existing.version)));
    return "requeued_for_corrected_pair";
  }
  // pending / queued / submitting / submitted: the old pair has not been accepted — re-point at the new one.
  await tx
    .update(AGG)
    .set(pairColumns)
    .where(and(eq(AGG.id, existing.id), eq(AGG.version, existing.version)));
  return "repointed";
}

export interface M18SubmissionPrepConsumerDeps {
  readonly db: DbClient;
  readonly aggregator: EvvAggregatorDeps;
}

/** The live consumer. The tenant is `event.organizationId` (the envelope), never the payload. */
export function buildM18SubmissionPrepConsumer(deps: M18SubmissionPrepConsumerDeps) {
  return {
    consumerName: M18_SUBMISSION_PREP_CONSUMER.consumerName,
    consumerModule: "m18" as const,
    eventTypes: [M18_SUBMISSION_PREP_CONSUMER.eventName] as const,
    async handle(event: {
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      await prepareAggregatorSubmission(
        deps.db,
        deps.aggregator,
        event.organizationId,
        factsOf(event.payload),
      );
    },
  };
}
