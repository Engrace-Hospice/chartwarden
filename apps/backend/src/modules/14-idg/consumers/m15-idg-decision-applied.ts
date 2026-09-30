// apps/backend/src/modules/14-idg/consumers/m15-idg-decision-applied.ts — M14's live consumer of
// `m15.idg_decision.applied` (F-232 / #248; M15 spec §4.5: "IDG decision applied … consumer M14").
//
// M15 acknowledges that it APPLIED an emitted `discipline_plan_update` decision to a draft next version of a
// discipline plan. M14 records the acknowledgement durably — one `idg_decision_application_ack` row per
// (decision, module), append-only for the app role — so the coordinator can see the decision went somewhere
// ("applied to plan v3, 2 mutations") rather than stopping at `emitted`. Before this, `idg_decision.status`
// ran `open -> emitted -> superseded` only and M14 consumed none of the M7/M11/M12/M15 acknowledgements.
//
// It is an acknowledgement, not a status: the decision row is immutable once emitted (`updateDecision` refuses
// a non-`open` row; the M4 trigger guards content), so this writes a NEW row and leaves the decision alone.
// Idempotent: the unique (org, decision, module) index absorbs a redelivery with `ON CONFLICT DO NOTHING`.
// A decision id that does not resolve in the org is a THROW (visible retry/dead-letter), never a silent skip —
// an acknowledgement for a decision M14 has no record of is a real inconsistency.
//
// The consumed event name is a STRING literal and no M15 schema is imported: M14 reads M15 solely through the
// outbox, so this adds no `dependsOn` edge.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";

const DEC = schema.idgDecision;
const ACK = schema.idgDecisionApplicationAck;

/** §3.3 — a consumer-driven write names no acting membership. */
const CONSUMER_USER_ID = "";

export const M14_M15_DECISION_APPLIED_CONSUMER = {
  eventName: "m15.idg_decision.applied",
  consumerName: "m14.m15-idg-decision-applied",
} as const;

export interface IdgDecisionAppliedConsumerDeps {
  readonly db: DbClient;
}

const fail = (message: string): never => {
  throw new Error(`${M14_M15_DECISION_APPLIED_CONSUMER.consumerName}: ${message}`);
};

function uuidOf(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : fail(`'${key}' must be an id`);
}

export function buildM14DecisionAppliedConsumer(
  deps: IdgDecisionAppliedConsumerDeps,
): OutboxConsumerBinding {
  return {
    consumerName: M14_M15_DECISION_APPLIED_CONSUMER.consumerName,
    consumerModule: "m14",
    eventTypes: [M14_M15_DECISION_APPLIED_CONSUMER.eventName],
    async handle(event): Promise<void> {
      const payload = event.payload;
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        return fail("payload must be an object");
      }
      const p = payload as Record<string, unknown>;
      const decisionId = uuidOf(p, "idgDecisionId");
      const planId = uuidOf(p, "planId");
      const versionId = uuidOf(p, "versionId");
      const applied = p.mutationsApplied;
      if (typeof applied !== "number" || !Number.isInteger(applied) || applied < 0) {
        return fail("'mutationsApplied' must be a non-negative integer");
      }

      const organizationId = event.organizationId;
      await withOrgContext(deps.db, { organizationId, userId: CONSUMER_USER_ID }, async (tx) => {
        const [decision] = await tx
          .select({
            id: DEC.id,
            meetingId: DEC.idgMeetingId,
            patientId: DEC.patientId,
            providerEntityId: DEC.providerEntityId,
            locationId: DEC.locationId,
          })
          .from(DEC)
          .where(and(eq(DEC.organizationId, organizationId), eq(DEC.id, decisionId)))
          .limit(1);
        if (!decision) return fail(`decision '${decisionId}' not found in the tenant`);
        await tx
          .insert(ACK)
          .values({
            organizationId,
            providerEntityId: decision.providerEntityId,
            locationId: decision.locationId,
            idgDecisionId: decision.id,
            idgMeetingId: decision.meetingId,
            patientId: decision.patientId,
            targetModule: "m15",
            planId,
            versionId,
            mutationsApplied: applied,
            sourceOutboxEventId: event.id,
          })
          .onConflictDoNothing({
            target: [ACK.organizationId, ACK.idgDecisionId, ACK.targetModule],
          });
      });
    },
  };
}
