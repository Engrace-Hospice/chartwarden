// apps/backend/src/modules/13-emar/outbox-consumers/m21-comfort-kit-return-reconciliation.ts — the §2.6/D8
// comfort-kit return-reconciliation close-out, live for the first time (F-166, #248).
//
// `reconcileKitReturnLine` (`@wardenx/emar`, `comfort-kit/comfort-kit.ts`) has been a complete, pure,
// unit-tested core since M13-T05. `m21.comfort_kit.return_reconciliation` was NOT on
// `M13_OUTBOX_SUBSCRIPTIONS` at all (only `.deployed_at_patient` and `.returned` were listed — corrected
// in the same change that adds this file) despite the event's OWN catalog description in
// `events-by-m21.ts` naming exactly this consumer's job: "M13 closes its drawdowns; M30 files the survey
// record when `discrepancyDetected`."
//
// NOT REDUNDANT WITH `m21.comfort_kit.returned` (`m21-comfort-kit-returned.ts`, same pass): that event is
// the disposal-status FLIP (deployment-level, boolean-ish fact); this one is the FULL per-line accounting
// — the cross-check between what M13's OWN administration-tracked `remaining_quantity` believed was left
// in the kit and what the returning supply-team member PHYSICALLY COUNTED at return. `reconcileKitReturnLine`
// computes `deltaQuantity`/`deltaPercent` from exactly that comparison — a genuinely different question
// from M21's own dispatched-vs-returned-vs-disposed check (`computeReturnReconciliation`,
// `@wardenx/supplies`), which is why both events exist and both need a consumer.
//
// `actualRemainingQuantity` — WHAT M21'S PAYLOAD ACTUALLY MEANS BY IT. `ComfortKitReturnedContentPayload`
// carries `quantityReturned` + `quantityDisposedAtHome`, never a single "remaining at return" figure.
// Their SUM is what was physically accounted for as still-existing (not yet administered) at the moment
// of return — `quantityReturned` (handed back to the hub) plus `quantityDisposedAtHome` (destroyed on
// site) is exactly the quantity the returning staff counted as "left in the kit", which is
// `KitReturnReconciliationLine.actualRemainingQuantity`'s own documented meaning.
//
// SAME NULLABLE-`medicationOrderId` POSTURE (see `m21-comfort-kit-deployed.ts`'s header): a line with no
// `medicationOrderId`, or one with no matching drawdown row (never tracked at deployment — a floor-stock
// line, or one predating this binding), has nothing to close and is skipped, not fabricated.
//
// TWO OUTBOX EMITS, BOTH CATALOGUED. `m13.comfort_kit.controlled_substance_discrepancy` (declaredConsumers
// ["m21"]) now carries `returnId` (F-172, #248) — this consumer is ITSELF the `m21.comfort_kit
// .return_reconciliation` handler, so `payload.returnId` (the M21 return this whole transaction is
// reconciling) is already in scope; widening was mechanical, not a new read. That is what unblocked M21's
// own `decideControlledSubstanceReemit`, whose only prior obstacle was the catalogued
// `m21.controlled_substance.discrepancy_detected` schema's non-nullable `returnId` + full `custodyChain`,
// which this bedside-adjacent re-emit could not previously supply. M21's live consumer
// (`21-supplies/outbox-consumers/m13-comfort-kit-cascade.ts`) resolves the rest — the dispatch context,
// the REAL `comfort_kit_returned_content` row (already written by the SAME M21 `reconcileReturn`
// transaction that triggered this one, strictly before this M13 event could ever fire), and the
// `comfort_kit_return` row's own custody columns — by `returnId` alone. `m13.comfort_kit.returned` (declaredConsumers: [],
// seamConsumers: ["m33"]) carries the aggregate `finalRemainingByMedication` + `disposalReconciliationStatus`
// this consumer is the only one with the data to assemble — emitted from HERE, not from the sibling
// `.returned` consumer, which never learns the per-line figures at all (see that file's header).
//
// IDEMPOTENCY WITHOUT A VERSION COLUMN: each drawdown UPDATE conditions on
// `final_remaining_quantity_at_return IS NULL`, so a redelivery after the first commit matches zero rows
// per line — a silent no-op, not a double-write. The deployment's `disposal_reconciliation_status` UPDATE
// conditions on `IS DISTINCT FROM 'pending'` being false (i.e. still unset/pending), the same guard shape.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { reconcileKitReturnLine } from "@wardenx/emar";
import type { M21ComfortKitReturnReconciliationPayload } from "@wardenx/types";
import { and, eq, isNull, or } from "drizzle-orm";
import type { EmarWriteOutboxPort } from "../emar-route-service-db";

const DEPLOYMENT = schema.comfortKitDeployments;
const DRAWDOWN = schema.comfortKitDrawdowns;

export const M13_COMFORT_KIT_RETURN_RECONCILIATION_CONSUMER = {
  eventName: "m21.comfort_kit.return_reconciliation",
  consumerName: "m13.comfort-kit-return-reconciliation",
} as const;

export interface ComfortKitReturnReconciliationConsumerDeps {
  readonly db: DbClient;
  readonly outbox: EmarWriteOutboxPort;
}

/** M13's live `m21.comfort_kit.return_reconciliation` binding (§2.6/D8). */
export function buildM13ComfortKitReturnReconciliationConsumer(
  deps: ComfortKitReturnReconciliationConsumerDeps,
) {
  return {
    consumerName: M13_COMFORT_KIT_RETURN_RECONCILIATION_CONSUMER.consumerName,
    consumerModule: "m13" as const,
    eventTypes: [M13_COMFORT_KIT_RETURN_RECONCILIATION_CONSUMER.eventName] as const,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const payload = (event.payload ?? {}) as M21ComfortKitReturnReconciliationPayload;
      if (typeof payload.m13DeploymentId !== "string") {
        throw new Error(
          `${M13_COMFORT_KIT_RETURN_RECONCILIATION_CONSUMER.consumerName}: payload has no m13DeploymentId`,
        );
      }
      const organizationId = event.organizationId;
      const deploymentId = payload.m13DeploymentId;
      const lines = payload.perMedicationReconciliation ?? [];

      await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as unknown as DbClient;

        const existingRows = await tx
          .select({
            medicationOrderId: DRAWDOWN.medicationOrderId,
            remainingQuantity: DRAWDOWN.remainingQuantity,
            expectedQuantity: DRAWDOWN.expectedQuantity,
            finalRemainingQuantityAtReturn: DRAWDOWN.finalRemainingQuantityAtReturn,
          })
          .from(DRAWDOWN)
          .where(eq(DRAWDOWN.comfortKitDeploymentId, deploymentId));
        const byOrder = new Map(existingRows.map((r) => [r.medicationOrderId, r] as const));

        const finalRemainingByMedication: Record<string, number> = {};
        let anyDiscrepancy = false;

        for (const line of lines) {
          const orderId: string | null = line.medicationOrderId;
          const existing = orderId ? byOrder.get(orderId) : undefined;
          if (!orderId || !existing) continue; // floor-stock or never tracked — see file header
          if (existing.finalRemainingQuantityAtReturn !== null) continue; // already reconciled — redelivery

          const actualRemainingQuantity =
            Number(line.quantityReturned) + Number(line.quantityDisposedAtHome);

          const result = reconcileKitReturnLine(deploymentId, {
            medicationOrderId: orderId,
            trackedRemainingQuantity: Number(existing.remainingQuantity),
            actualRemainingQuantity,
            expectedQuantity: Number(existing.expectedQuantity),
            isControlled: line.isControlledSubstance,
          });

          await tx
            .update(DRAWDOWN)
            .set({
              finalRemainingQuantityAtReturn: String(result.finalRemainingQuantityAtReturn),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(DRAWDOWN.comfortKitDeploymentId, deploymentId),
                eq(DRAWDOWN.medicationOrderId, orderId),
                isNull(DRAWDOWN.finalRemainingQuantityAtReturn),
              ),
            );

          finalRemainingByMedication[orderId] = result.finalRemainingQuantityAtReturn;

          if (result.controlledDiscrepancySignal) {
            anyDiscrepancy = true;
            await deps.outbox.publish(tx, {
              eventName: "m13.comfort_kit.controlled_substance_discrepancy",
              organizationId,
              aggregateKind: "comfort_kit_deployment",
              aggregateId: deploymentId,
              payload: {
                deploymentId,
                medicationOrderId: orderId,
                // F-172 (#248) — already in scope: this handler IS the return_reconciliation consumer.
                returnId: payload.returnId,
                deltaQuantity: result.controlledDiscrepancySignal.deltaQuantity,
                deltaPercent: result.controlledDiscrepancySignal.deltaPercent,
              },
            });
          }
        }

        const disposalReconciliationStatus = payload.discrepancyDetected || anyDiscrepancy
          ? "discrepancy"
          : "matched";

        await tx
          .update(DEPLOYMENT)
          .set({ disposalReconciliationStatus })
          .where(
            and(
              eq(DEPLOYMENT.id, deploymentId),
              or(
                isNull(DEPLOYMENT.disposalReconciliationStatus),
                eq(DEPLOYMENT.disposalReconciliationStatus, "pending"),
              ),
            ),
          );

        await deps.outbox.publish(tx, {
          eventName: "m13.comfort_kit.returned",
          organizationId,
          aggregateKind: "comfort_kit_deployment",
          aggregateId: deploymentId,
          payload: {
            deploymentId,
            returnedAt: payload.reconciledAt,
            finalRemainingByMedication,
            disposalReconciliationStatus,
          },
        });
      });
    },
  };
}

