// apps/backend/src/modules/13-emar/outbox-consumers/m21-comfort-kit-deployed.ts — the §2.5/§2.7 D5
// comfort-kit deployment intake, live for the first time (F-166, #248).
//
// `buildComfortKitDeployment` (`@wardenx/emar`, `comfort-kit/comfort-kit.ts`) has been a complete, pure,
// unit-tested deployment materializer since M13-T05, and `M13_OUTBOX_SUBSCRIPTIONS`
// (`../consumers/index.ts`) has named `m21.comfort_kit.deployed_at_patient` with a real consumer
// (`m13.comfort-kit-deployed`) since the list was written — nothing has ever bound it. One layer down:
// `comfort_kit_deployment` and `comfort_kit_drawdown` have never had a live writer anywhere in this
// repository, so a comfort kit physically placed at a patient's bedside was never trackable in the eMAR at
// all, and M21's own `m13.comfort_kit.deployed` ack consumer (`buildM21ComfortKitDeploymentAckConsumer`,
// F-153, `21-supplies/outbox-consumers/m13-comfort-kit-cascade.ts`) has sat waiting, unreachable, for an
// event this side of the handshake never published.
//
// NULLABLE `medicationOrderId` — A REAL, DOCUMENTED PRODUCT DECISION, NOT A GUESS. Every content line on
// this payload (`ComfortKitDispatchedContentPayload`) carries `medicationOrderId: MedicationOrderId |
// null` — null for the IPU-stock-kit-on-room case and the pre-positioned-at-home stock-kit case where the
// order signs LATER, at deployment (M21's own spec, §"The medication identity", line 58: those lines
// instead carry `comfortKitTemplateMedicationId`, an M21-internal identity). `comfort_kit_drawdown.
// medication_order_id` is NOT NULL, and — checked, not assumed — NO table anywhere in M13's schema, and NO
// type anywhere in `@wardenx/emar`'s pure comfort-kit core (`KitContentLine`, `KitDrawdownInit`,
// `KitDrawdownState`, `KitReturnReconciliationLine` all require it), has ever represented an
// order-less drawdown or administration. `administration_record.medication_order_id` is NOT NULL too.
// Inventing a floor-stock drawdown shape here — a second key, a relaxed constraint, a new "no order"
// administration mode — would be deciding unreviewed DEA-adjacent controlled-substance-accounting
// semantics on the fly, the exact mistake this codebase's own F-102 "a guessed provider entity is a
// mis-stated cost report" lesson warns against, one module over. So this consumer tracks every line WITH
// an order for real (the documented "typical case" per M21's spec — a comfort-kit-deploy with the four
// platform-floor medications prescribed at admission) and DELIBERATELY, VISIBLY skips a line with none:
// `skippedFloorStockLines` rides on the `m13.comfort_kit.deployed` ack payload rather than being silently
// dropped, so a reader of the outbox row can see exactly what M13 chose not to track and why. A pure
// floor-stock kit (every line order-less) still gets its `comfort_kit_deployment` ROW — the row's own
// columns (siting, disposal lifecycle) need no per-line order at all — it simply carries zero drawdown
// rows underneath, honestly.
//
// TENANCY. `comfort_kit_deployment.provider_entity_id`/`location_id` are NOT NULL (the three-column
// tenancy rule) and this event's payload carries neither directly usable form — `providerEntityId`/
// `locationId` ARE on `M21PatientScopedEventBase`, so they are read straight off the envelope, unlike the
// M12/M6-sourced consumers in this directory that need an injected seam read.
//
// IDEMPOTENCY. `comfort_kit_deployment_m21_dispatch_uq` (organization_id, m21_supply_dispatch_id —
// migration 0259) is the redelivery guard for the deployment row: `.onConflictDoNothing()` targets it
// directly, and an empty `.returning()` means a prior delivery already created (and, presumably, fully
// drew down against) this deployment — the consumer stops there rather than risk re-creating drawdown
// rows a clinician may have already decremented. `kit_drawdown_deployment_order_uk` (comfort_kit_
// deployment_id, medication_order_id) is the per-line guard for the (normal, non-redelivery) case where
// the deployment insert succeeds but a later step fails and retries — `.onConflictDoNothing()` there too.
import { type DbClient, schema } from "@wardenx/db";
import { type KitContentLine, buildComfortKitDeployment } from "@wardenx/emar";
import { withOrgContext } from "@wardenx/tenancy";
import type {
  ComfortKitDispatchedContentPayload,
  M21ComfortKitDeployedAtPatientPayload,
} from "@wardenx/types";
import type { EmarWriteOutboxPort } from "../emar-route-service-db";

const DEPLOYMENT = schema.comfortKitDeployments;
const DRAWDOWN = schema.comfortKitDrawdowns;

export const M13_COMFORT_KIT_DEPLOYED_INTAKE_CONSUMER = {
  eventName: "m21.comfort_kit.deployed_at_patient",
  consumerName: "m13.comfort-kit-deployed",
} as const;

export interface ComfortKitDeployedIntakeDeps {
  readonly db: DbClient;
  readonly outbox: EmarWriteOutboxPort;
  readonly now?: () => Date;
}

function toContentLine(c: ComfortKitDispatchedContentPayload): KitContentLine {
  return {
    // Non-null by construction — only called after filtering to `medicationOrderId !== null` lines.
    medicationOrderId: c.medicationOrderId as string,
    expectedQuantity: Number(c.dispatchedQuantity),
    expectedUnit: c.dispatchedUnit,
    lotNumber: c.lotNumber,
    expirationDate: c.expirationDate,
    replenishmentThresholdFraction: c.replenishmentThresholdPct,
    isControlled: c.isControlledSubstance,
  };
}

/**
 * M13's live `m21.comfort_kit.deployed_at_patient` binding (§2.5/§2.7 D5). Inserts the deployment row
 * unconditionally (siting alone needs no order), then materializes one `comfort_kit_drawdown` per
 * ORDER-LINKED content line via the pure `buildComfortKitDeployment`. Emits `m13.comfort_kit.deployed` —
 * M21's own `buildM21ComfortKitDeploymentAckConsumer` (F-153) is the real, already-bound consumer waiting
 * for this event to bind `comfort_kit_dispatch.m13_deployment_id`.
 */
export function buildM13ComfortKitDeployedConsumer(deps: ComfortKitDeployedIntakeDeps) {
  return {
    consumerName: M13_COMFORT_KIT_DEPLOYED_INTAKE_CONSUMER.consumerName,
    consumerModule: "m13" as const,
    eventTypes: [M13_COMFORT_KIT_DEPLOYED_INTAKE_CONSUMER.eventName] as const,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const payload = (event.payload ?? {}) as M21ComfortKitDeployedAtPatientPayload;
      if (typeof payload.patientId !== "string" || typeof payload.admissionId !== "string") {
        throw new Error(
          `${M13_COMFORT_KIT_DEPLOYED_INTAKE_CONSUMER.consumerName}: payload has no patientId/admissionId`,
        );
      }
      if (typeof payload.dispatchId !== "string") {
        throw new Error(
          `${M13_COMFORT_KIT_DEPLOYED_INTAKE_CONSUMER.consumerName}: payload has no dispatchId`,
        );
      }
      const organizationId = event.organizationId;
      const at = deps.now?.() ?? new Date();

      await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as unknown as DbClient;

        const inserted = await tx
          .insert(DEPLOYMENT)
          .values({
            organizationId,
            providerEntityId: payload.providerEntityId,
            locationId: payload.locationId,
            patientId: payload.patientId,
            admissionId: payload.admissionId,
            deployedAt: new Date(payload.deployedAt),
            deployedByMembershipId: payload.deployedByMembershipId,
            m21SupplyDispatchId: payload.dispatchId,
            disposalStatus: "deployed",
            createdAt: at,
          })
          .onConflictDoNothing({
            target: [DEPLOYMENT.organizationId, DEPLOYMENT.m21SupplyDispatchId],
          })
          .returning({ id: DEPLOYMENT.id });

        const deploymentRow = inserted[0];
        if (!deploymentRow) return; // redelivery — this dispatch was already deployed in M13

        const deploymentId = deploymentRow.id;
        const contents = payload.contents ?? [];
        const orderLinked = contents.filter(
          (c): c is ComfortKitDispatchedContentPayload & { medicationOrderId: string } =>
            typeof c.medicationOrderId === "string",
        );
        const skippedFloorStockLines = contents.length - orderLinked.length;

        let trackedContents: readonly {
          medicationOrderId: string;
          expectedQuantity: number;
          expectedUnit: string;
        }[] = [];
        if (orderLinked.length > 0) {
          const plan = buildComfortKitDeployment({
            deploymentId,
            patientId: payload.patientId,
            admissionId: payload.admissionId,
            deployedAtIso: payload.deployedAt,
            deployedByMembershipId: payload.deployedByMembershipId,
            contents: orderLinked.map(toContentLine),
          });

          await tx
            .insert(DRAWDOWN)
            .values(
              plan.drawdowns.map((d) => ({
                organizationId,
                comfortKitDeploymentId: d.comfortKitDeploymentId,
                medicationOrderId: d.medicationOrderId,
                expectedQuantity: String(d.expectedQuantity),
                expectedUnit: d.expectedUnit,
                remainingQuantity: String(d.remainingQuantity),
                replenishmentThreshold: String(d.replenishmentThreshold),
                lotNumber: d.lotNumber,
                expirationDate: d.expirationDate,
              })),
            )
            .onConflictDoNothing({
              target: [DRAWDOWN.comfortKitDeploymentId, DRAWDOWN.medicationOrderId],
            });

          trackedContents = plan.deployedSignal.contents;
        }

        await deps.outbox.publish(tx, {
          eventName: "m13.comfort_kit.deployed",
          organizationId,
          aggregateKind: "comfort_kit_deployment",
          aggregateId: deploymentId,
          payload: {
            deploymentId,
            patientId: payload.patientId,
            admissionId: payload.admissionId,
            contents: trackedContents,
            // Honest, visible degradation — never a silent drop. See the file header.
            skippedFloorStockLineCount: skippedFloorStockLines,
          },
        });
      });
    },
  };
}
