// apps/backend/src/modules/12-dosespot/consumers/draft-order-requested-binding.ts — the live
// `OutboxConsumerBinding` for M12's §2.8 D17 reconciliation "draft order" handshake (F-16x, #248).
//
// WHAT WAS MISSING. `m13.reconciliation.draft_order_requested` already declares `m12` as a consumer
// (`events-by-m13.ts`) and is now emitted with real drug content by the real M13 write path (see
// `../draft-order-requested.ts`'s header) — nothing on the M12 side had ever consumed it at all (the
// `m12`/`handlers-unbound` group, `scripts/outbox-deferred-consumers.ts`). A reconciliation decision to
// carry a home medication forward, or author a newly identified one, was recorded on M13's own
// `medication_reconciliation_decision` row and then went nowhere — no draft `medication_order` was ever
// minted, so the clinician's decision had no downstream artifact for a prescriber to ever sign.
//
// IDEMPOTENCY. `medication_order` is PARTITION BY RANGE(created_at), so a direct unique constraint on
// `(organization_id, triggering_reconciliation_decision_id)` cannot be created — Postgres requires the
// partition key in every unique index on a partitioned table (the same reason `dosespot_prescription_id`'s
// uniqueness is enforced at the app layer, not the DB). `medication_order_reconciliation_decision_application`
// (migration 0254) is a separate, non-partitioned ledger — the `medication_order_idg_decision_application`
// precedent (migration 0168) applied to this handshake instead of the IDG one — checked before the insert
// and written in the SAME transaction as it, so a redelivery after a partial failure can never mint a
// second draft for the same decision.
//
// CONTEXT RESOLUTION. Siting (`provider_entity_id`/`location_id`) and the ordering physician
// (`prescribing_physician_mdm_id`, NOT NULL) are resolved via M6's `activeAdmissionDraftContextForPatient`
// seam — the SAME shared function the already-live `m12.idg-decision-intake` consumer
// (`outbox-consumers/m14-idg-decision-recorded.ts`) binds, injected here rather than imported (M12 has no
// `dependsOn` edge to M6; the composition root wires the same function into both). No active admission for
// the patient is a genuine data gap — the event is preserved (thrown, not swallowed) rather than minting an
// unsited/unattributed order.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type { DeaSchedule, MedClass } from "@wardenx/types";
import { and, eq } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import type { DoseSpotWriteOutboxPort } from "../dosespot-route-service-db";
import {
  type DraftOrderAdmissionContext,
  type DraftOrderRequestedPayload,
  planDraftMedicationOrder,
} from "./draft-order-requested";

const MO = schema.medicationOrders;
const APPLICATION = schema.medicationOrderReconciliationDecisionApplications;

/** The event M12's reconciliation-draft-order consumer subscribes to, and the `(eventId, consumerName)`
 *  receipt identity. */
export const M12_DRAFT_ORDER_REQUESTED_CONSUMER = {
  eventName: "m13.reconciliation.draft_order_requested",
  consumerName: "m12.reconciliation-draft-order",
} as const;

export interface DraftOrderRequestedConsumerDeps {
  readonly db: DbClient;
  /** The bound publisher — `Value.Check`s each payload against the boot catalog and rolls the tx back on a
   *  mismatch, so an invalid emit cannot leave a draft order minted without its `draft_created` event. */
  readonly outbox: DoseSpotWriteOutboxPort;
  /** M6's org-explicit admission-siting + ordering-physician seam (the `m12.idg-decision-intake` shape). */
  resolveAdmissionContext(
    organizationId: string,
    patientId: string,
  ): Promise<DraftOrderAdmissionContext | null>;
}

const MED_CLASSES: ReadonlySet<string> = new Set(["standard", "controlled_substance", "compounded"]);
const DEA_SCHEDULES: ReadonlySet<string> = new Set(["II", "III", "IV", "V"]);

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
function nullableStringField(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function parsePayload(payload: unknown): DraftOrderRequestedPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  const worksheetId = stringField(p, "worksheetId");
  const decisionId = stringField(p, "decisionId");
  const patientId = stringField(p, "patientId");
  const decisionMadeByMembershipId = stringField(p, "decisionMadeByMembershipId");
  if (p.lineKind !== "caregiver_reported") return null; // the only reachable value on this event today
  if (!worksheetId || !decisionId || !patientId || !decisionMadeByMembershipId) return null;

  const draft = p.medicationOrderDraftPayload;
  if (typeof draft !== "object" || draft === null) return null;
  const d = draft as Record<string, unknown>;
  const drugName = stringField(d, "drugName");
  const strength = stringField(d, "strength");
  const doseForm = stringField(d, "doseForm");
  const route = stringField(d, "route");
  const medClass = d.medClass;
  if (!drugName || !strength || !doseForm || !route) return null;
  if (typeof medClass !== "string" || !MED_CLASSES.has(medClass)) return null;
  const deaSchedule = nullableStringField(d, "deaSchedule");
  if (deaSchedule !== undefined && deaSchedule !== null && !DEA_SCHEDULES.has(deaSchedule)) return null;
  const rxnormRxcui = nullableStringField(d, "rxnormRxcui");
  const ndc = nullableStringField(d, "ndc");
  if (rxnormRxcui === undefined && d.rxnormRxcui !== undefined) return null; // present but wrong-typed
  if (ndc === undefined && d.ndc !== undefined) return null;

  const derivedFromHistoryIdRaw = p.derivedFromHistoryId;
  const derivedFromHistoryId =
    typeof derivedFromHistoryIdRaw === "string" ? derivedFromHistoryIdRaw : null;

  return {
    worksheetId,
    decisionId,
    patientId,
    decisionMadeByMembershipId,
    lineKind: "caregiver_reported",
    medicationOrderDraftPayload: {
      drugName,
      strength,
      doseForm,
      route,
      medClass: medClass as MedClass,
      deaSchedule: (deaSchedule ?? null) as DeaSchedule | null,
      rxnormRxcui: rxnormRxcui ?? null,
      ndc: ndc ?? null,
    },
    derivedFromHistoryId,
  };
}

/**
 * M12's live `m13.reconciliation.draft_order_requested` binding (§2.8 D17 / §4.5).
 *
 * Idempotent via `medication_order_reconciliation_decision_application`: a redelivery for a decision
 * already applied is a clean no-op (checked before the insert, inside the same transaction as it, so a
 * concurrent redelivery cannot race past the check — the unique index on
 * `(organization_id, reconciliation_decision_id)` is the final backstop if it somehow did).
 */
export function buildM12DraftOrderRequestedConsumer(
  deps: DraftOrderRequestedConsumerDeps,
): OutboxConsumerBinding {
  return {
    consumerName: M12_DRAFT_ORDER_REQUESTED_CONSUMER.consumerName,
    consumerModule: "m12",
    eventTypes: [M12_DRAFT_ORDER_REQUESTED_CONSUMER.eventName],
    async handle(event): Promise<void> {
      const payload = parsePayload(event.payload);
      if (payload === null) {
        throw new Error(`${M12_DRAFT_ORDER_REQUESTED_CONSUMER.consumerName}: malformed payload`);
      }
      const organizationId = event.organizationId;

      const context = await deps.resolveAdmissionContext(organizationId, payload.patientId);
      if (!context) {
        throw new Error(
          `${M12_DRAFT_ORDER_REQUESTED_CONSUMER.consumerName}: patient '${payload.patientId}' has no ` +
            "active admission; preserving event",
        );
      }

      await withOrgContext(deps.db, { organizationId, userId: "" }, async (rawTx) => {
        const tx = rawTx as DbClient;
        const [applied] = await tx
          .select({ id: APPLICATION.id })
          .from(APPLICATION)
          .where(
            and(
              eq(APPLICATION.organizationId, organizationId),
              eq(APPLICATION.reconciliationDecisionId, payload.decisionId),
            ),
          )
          .limit(1);
        if (applied) return;

        const plan = planDraftMedicationOrder(payload, context);
        const [order] = await tx
          .insert(MO)
          .values({
            organizationId,
            patientId: plan.patientId,
            admissionId: plan.admissionId,
            providerEntityId: plan.providerEntityId,
            locationId: plan.locationId,
            medClass: plan.medClass,
            isControlledSubstance: plan.isControlledSubstance,
            deaSchedule: plan.deaSchedule,
            rxnormRxcui: plan.rxnormRxcui,
            ndc: plan.ndc,
            drugName: plan.drugName,
            strength: plan.strength,
            doseForm: plan.doseForm,
            route: plan.route,
            data: plan.data,
            prescriberMembershipId: plan.prescriberMembershipId,
            prescribingPhysicianMdmId: plan.prescribingPhysicianMdmId,
            refillsAuthorized: 0,
            refillsRemaining: 0,
            status: "draft",
            derivedFromHistoryId: plan.derivedFromHistoryId,
            triggeringReconciliationDecisionId: plan.triggeringReconciliationDecisionId,
          })
          .returning({ id: MO.id });
        if (!order) {
          throw new Error(
            `${M12_DRAFT_ORDER_REQUESTED_CONSUMER.consumerName}: medication order insert returned no row`,
          );
        }

        await tx.insert(APPLICATION).values({
          organizationId,
          reconciliationDecisionId: payload.decisionId,
          medicationOrderId: order.id,
        });

        await deps.outbox.publish(tx, {
          eventName: "m12.medication_order.draft_created",
          organizationId,
          aggregateKind: "medication_order",
          aggregateId: order.id,
          payload: {
            orderId: order.id,
            patientId: plan.patientId,
            medClass: plan.medClass,
            isControlledSubstance: plan.isControlledSubstance,
          },
        });
      });
    },
  };
}
