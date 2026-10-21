// apps/backend/src/modules/21-supplies/outbox-consumers/m13-comfort-kit-cascade.ts — M21's live binding
// for three of the four `../consumers/m13-comfort-kit.ts` deciders (F-141/#248's m21 group, this pass;
// the controlled-substance re-emit added F-172, #248).
//
// `decideDeploymentAck` (§2.5) and `decideReturnRequired` (§2.6) have been complete, exported and
// unit-tested since M21-T04, and both are named on M21's own `M21_SUBSCRIBED_EVENT_NAMES`
// (packages/types/src/supplies.ts) — nothing has ever bound either to the dispatcher.
//
// `decideReplenishmentIntake` (§2.1) is NOT bound here — it needs the SAME shared `insertRequest` write
// path `write-service-drizzle.ts`'s `createDirect` seam method calls (the `patchSupplyRequest` precedent,
// F-102) and lives in its own file, `m13-comfort-kit-replenishment.ts`.
//
// `decideControlledSubstanceReemit` (§4.5.1) IS NOW BOUND (F-172, #248). It was genuinely payload-BLOCKED,
// not merely unbound: the catalogued `m21.controlled_substance.discrepancy_detected` schema
// (events-by-m21.ts) requires a non-nullable `returnId` plus a full `custodyChain` — the shape a
// RECONCILIATION-time discrepancy carries, which M13's re-emit (fired from
// `13-emar/outbox-consumers/m21-comfort-kit-return-reconciliation.ts`, itself the
// `m21.comfort_kit.return_reconciliation` consumer) genuinely IS, despite the file header comment this
// replaced saying otherwise — that comment was written when M13's discrepancy re-emit fired at bedside
// ADMINISTRATION time; it has fired at true RECONCILIATION time since F-166. `returnId` was simply never
// added to the wire payload even though the emit site already had it in scope. Widened additively
// (`events-by-m13.ts`), and the decider now resolves the REAL `comfort_kit_returned_content` row (already
// written by M21's OWN `reconcileReturn` transaction, strictly before M13's re-emit can ever fire) plus
// the `comfort_kit_return` row's own custody columns, keyed by that `returnId` — no fact is invented.
//
// THREE SEAMS TO ONE OUTCOME. `linkM13Deployment`, the return-open, and the controlled-substance re-emit
// all run with NO acting membership — the `m11-order-cascade.ts` / F-102 `CONSUMER_USER_ID` convention —
// because all three cascades are M13 telling M21 something happened, not a human acting on the row.
import { type DbClient, schema } from "@chartwarden/db";
import { RETURN_WINDOW_HOURS_DEFAULT } from "@chartwarden/supplies";
import { withOrgContext } from "@chartwarden/tenancy";
import type { ComfortKitReturnedContentPayload } from "@chartwarden/types";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import {
  type ComfortKitDispatchContext,
  type ControlledSubstanceCustodyChainFacts,
  type M13ComfortKitDeployedPayload,
  type M13ControlledSubstanceDiscrepancyPayload,
  type M13ReturnRequiredPayload,
  M13_COMFORT_KIT_DEPLOYED_EVENT,
  M13_CONTROLLED_SUBSTANCE_DISCREPANCY_EVENT,
  M13_RETURN_REQUIRED_EVENT,
  decideControlledSubstanceReemit,
  decideDeploymentAck,
  decideReturnRequired,
} from "../consumers/m13-comfort-kit";
import { transitionComfortKitDispatch } from "../lifecycle/index";
import type { WriteOutboxPort } from "../routes/write-service";

const DISPATCH = schema.comfortKitDispatch;
const DISPATCHED = schema.comfortKitDispatchedContent;
const RETURN = schema.comfortKitReturn;
const RETURNED = schema.comfortKitReturnedContent;

/** A consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

export interface M21ComfortKitCascadeDeps {
  readonly db: DbClient;
  readonly now?: () => Date;
  readonly returnWindowHours?: number;
}

/** The re-emit consumer WRITES an outbox event (the other two in this file only patch a row), so it needs
 *  the catalog-validating publisher — a separate interface rather than widening
 *  `M21ComfortKitCascadeDeps` itself, so the deployment-ack/return-required builders' call sites do not
 *  need an unused `outbox` argument. */
export interface M21ComfortKitReemitDeps extends M21ComfortKitCascadeDeps {
  readonly outbox: WriteOutboxPort;
}

type DispatchRow = typeof DISPATCH.$inferSelect;

function toDispatchContext(
  row: DispatchRow,
  containsControlledSubstance: boolean,
): ComfortKitDispatchContext {
  return {
    dispatchId: row.id,
    supplyRequestId: row.supplyRequestId,
    dispatchStatus: row.dispatchStatus,
    patientId: row.patientId,
    admissionId: row.admissionId,
    providerEntityId: row.providerEntityId,
    locationId: row.locationId,
    dispatchedByMembershipId: row.dispatchedByMembershipId,
    containsControlledSubstance,
  };
}

/** `dispatched_content.is_controlled_substance` — the SAME "any controlled line" rule
 *  `seams/store-drizzle.ts`'s `dispatchDetailOf` applies, recomputed here rather than read through that
 *  seam because it opens `withOrgContextFromRequest`, which throws outside a request scope (a relay tick
 *  is not a request — the F-102/F-121 lesson). */
async function dispatchContainsControlledSubstance(
  tx: DbClient,
  dispatchId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ isControlled: DISPATCHED.isControlledSubstance })
    .from(DISPATCHED)
    .where(eq(DISPATCHED.dispatchId, dispatchId));
  return rows.some((r) => r.isControlled);
}

/**
 * M21's live `m13.comfort_kit.deployed` ack binding (§2.5).
 *
 * Resolved by PATIENT + ADMISSION, not by M13's `deploymentId`, per `decideDeploymentAck`'s own doc
 * comment: the whole point of the ack is that the link does not exist yet, so a deploymentId-keyed lookup
 * would find nothing. The newest deployed-and-unlinked dispatch for this (patient, admission) is the
 * target — the ordinary case is exactly one, and a redelivery finds none (already linked), which the
 * decider correctly reads as a `no_op` rather than a second link attempt.
 */
export function buildM21ComfortKitDeploymentAckConsumer(
  deps: M21ComfortKitCascadeDeps,
): OutboxConsumerBinding {
  return {
    consumerName: "m21.comfort-kit-deployment-ack",
    consumerModule: "m21",
    eventTypes: [M13_COMFORT_KIT_DEPLOYED_EVENT],
    async handle(event): Promise<void> {
      const payload = (event.payload ?? {}) as M13ComfortKitDeployedPayload;
      if (typeof payload.deploymentId !== "string") {
        throw new Error("m21.comfort-kit-deployment-ack: payload has no deploymentId");
      }
      if (typeof payload.patientId !== "string" || typeof payload.admissionId !== "string") {
        throw new Error("m21.comfort-kit-deployment-ack: payload has no patientId/admissionId");
      }
      const organizationId = event.organizationId;

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;
          const rows = await tx
            .select()
            .from(DISPATCH)
            .where(
              and(
                eq(DISPATCH.organizationId, organizationId),
                eq(DISPATCH.patientId, payload.patientId),
                eq(DISPATCH.admissionId, payload.admissionId),
                isNull(DISPATCH.m13DeploymentId),
              ),
            )
            .orderBy(desc(DISPATCH.deployedAtPatientAt))
            .limit(1);
          const row = rows[0] as DispatchRow | undefined;

          let dispatchWithLink:
            | (ComfortKitDispatchContext & { readonly m13DeploymentId: string | null })
            | null = null;
          if (row) {
            const containsControlledSubstance = await dispatchContainsControlledSubstance(
              tx,
              row.id,
            );
            dispatchWithLink = {
              ...toDispatchContext(row, containsControlledSubstance),
              m13DeploymentId: row.m13DeploymentId,
            };
          }

          const action = decideDeploymentAck(payload, dispatchWithLink);
          if (action.kind === "no_op" || !row) return;

          // Status-preserving — `transitionComfortKitDispatch` is still run (not assumed legal) so a future
          // machine edge cannot silently drift from the graph it enforces.
          transitionComfortKitDispatch(row.dispatchStatus, {
            type: "linkM13Deployment",
            m13DeploymentId: action.m13DeploymentId,
          });

          await tx
            .update(DISPATCH)
            .set({
              m13DeploymentId: action.m13DeploymentId,
              m13DeploymentLinkResolvedAt: deps.now?.() ?? new Date(),
              updatedAt: deps.now?.() ?? new Date(),
            })
            .where(eq(DISPATCH.id, row.id));
        },
      );
    },
  };
}

/**
 * M21's live `m13.comfort_kit.return_required` binding (§2.6) — opens the chain-of-custody return
 * obligation. No outbox event: `decideReturnRequired`'s action carries none (§4.5.1 declares no
 * "return opened" event; the return row's own state is the visible fact).
 */
export function buildM21ComfortKitReturnRequiredConsumer(
  deps: M21ComfortKitCascadeDeps,
): OutboxConsumerBinding {
  const returnWindowHours = deps.returnWindowHours ?? RETURN_WINDOW_HOURS_DEFAULT;
  return {
    consumerName: "m21.comfort-kit-return-required",
    consumerModule: "m21",
    eventTypes: [M13_RETURN_REQUIRED_EVENT],
    async handle(event): Promise<void> {
      const payload = (event.payload ?? {}) as M13ReturnRequiredPayload;
      if (typeof payload.deploymentId !== "string") {
        throw new Error("m21.comfort-kit-return-required: payload has no deploymentId");
      }
      const organizationId = event.organizationId;

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;

          const dispatchRows = await tx
            .select()
            .from(DISPATCH)
            .where(
              and(
                eq(DISPATCH.organizationId, organizationId),
                eq(DISPATCH.m13DeploymentId, payload.deploymentId),
              ),
            )
            .orderBy(desc(DISPATCH.dispatchedAt))
            .limit(1);
          const dispatchRow = dispatchRows[0] as DispatchRow | undefined;

          const existingRows = dispatchRow
            ? await tx
                .select({ id: RETURN.id })
                .from(RETURN)
                .where(eq(RETURN.dispatchId, dispatchRow.id))
                .limit(1)
            : [];
          const existingReturnId = existingRows[0]?.id ?? null;

          let dispatchContext: ComfortKitDispatchContext | null = null;
          if (dispatchRow) {
            const containsControlledSubstance = await dispatchContainsControlledSubstance(
              tx,
              dispatchRow.id,
            );
            dispatchContext = toDispatchContext(dispatchRow, containsControlledSubstance);
          }

          const action = decideReturnRequired(payload, {
            existingReturnId,
            dispatch: dispatchContext,
            returnWindowHours,
          });
          if (action.kind === "idempotent_skip" || !dispatchRow) return;

          await tx.insert(RETURN).values({
            dispatchId: action.draft.dispatchId,
            dispatchPartitionDispatchedAt: dispatchRow.dispatchedAt,
            m13DeploymentId: action.draft.m13DeploymentId,
            organizationId,
            patientId: action.draft.patientId,
            admissionId: action.draft.admissionId,
            providerEntityId: action.draft.providerEntityId,
            locationId: action.draft.locationId,
            returnRequiredAt: new Date(action.draft.returnRequiredAt),
            returnDueAt: new Date(action.draft.returnDueAt),
            state: action.draft.state as (typeof RETURN.$inferInsert)["state"],
            createdAt: deps.now?.() ?? new Date(),
            updatedAt: deps.now?.() ?? new Date(),
          });
        },
      );
    },
  };
}

/**
 * M21's live `m13.comfort_kit.controlled_substance_discrepancy` re-emit binding (§4.5.1, F-172/#248).
 *
 * M13's bedside-administration accounting and M21's own dispatched-vs-returned accounting are two
 * INDEPENDENT discrepancy checks over the same physical kit (see `decideControlledSubstanceReemit`'s own
 * doc comment on why the two can legitimately disagree) — this is not redundant with M21's own
 * `reconcileReturn` route, which separately emits `m21.controlled_substance.discrepancy_detected` with
 * `detectionSource: "return_reconciliation"` off its OWN reconciliation math in the same transaction.
 *
 * Resolved by `returnId` (M13's widened payload) + the dispatch M13's `deploymentId` maps to — the
 * `comfort_kit_returned_content` row for this exact (return, medication) already exists by the time this
 * ever runs, because M21's own `reconcileReturn` wrote it in the SAME transaction that later (via the
 * outbox) triggered the M13 consumer this event is re-emitted from.
 */
export function buildM21ComfortKitControlledSubstanceReemitConsumer(
  deps: M21ComfortKitReemitDeps,
): OutboxConsumerBinding {
  return {
    consumerName: "m21.comfort-kit-controlled-substance-reemit",
    consumerModule: "m21",
    eventTypes: [M13_CONTROLLED_SUBSTANCE_DISCREPANCY_EVENT],
    async handle(event): Promise<void> {
      const payload = (event.payload ?? {}) as M13ControlledSubstanceDiscrepancyPayload;
      if (typeof payload.deploymentId !== "string") {
        throw new Error("m21.comfort-kit-controlled-substance-reemit: payload has no deploymentId");
      }
      if (typeof payload.medicationOrderId !== "string") {
        throw new Error(
          "m21.comfort-kit-controlled-substance-reemit: payload has no medicationOrderId",
        );
      }
      if (typeof payload.returnId !== "string") {
        throw new Error("m21.comfort-kit-controlled-substance-reemit: payload has no returnId");
      }
      const organizationId = event.organizationId;

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (scoped) => {
          const tx = scoped as unknown as DbClient;

          const dispatchRows = await tx
            .select()
            .from(DISPATCH)
            .where(
              and(
                eq(DISPATCH.organizationId, organizationId),
                eq(DISPATCH.m13DeploymentId, payload.deploymentId),
              ),
            )
            .orderBy(desc(DISPATCH.dispatchedAt))
            .limit(1);
          const dispatchRow = dispatchRows[0] as DispatchRow | undefined;

          let dispatchContext: ComfortKitDispatchContext | null = null;
          if (dispatchRow) {
            const containsControlledSubstance = await dispatchContainsControlledSubstance(
              tx,
              dispatchRow.id,
            );
            dispatchContext = toDispatchContext(dispatchRow, containsControlledSubstance);
          }

          let returnedContent: ComfortKitReturnedContentPayload | null = null;
          if (dispatchRow) {
            const rows = await tx
              .select({
                returnedContentId: RETURNED.id,
                dispatchedContentId: RETURNED.dispatchedContentId,
                comfortKitTemplateMedicationId: DISPATCHED.comfortKitTemplateMedicationId,
                medicationOrderId: DISPATCHED.medicationOrderId,
                rxnorm: DISPATCHED.rxnorm,
                drugName: DISPATCHED.drugName,
                isControlledSubstance: RETURNED.isControlledSubstance,
                controlledSubstanceSchedule: RETURNED.controlledSubstanceSchedule,
                lotNumber: DISPATCHED.lotNumber,
                dispatchedQuantity: DISPATCHED.dispatchedQuantity,
                quantityReturned: RETURNED.quantityReturned,
                quantityDisposedAtHome: RETURNED.quantityDisposedAtHome,
                quantityUnaccounted: RETURNED.quantityUnaccounted,
                discrepancyPct: RETURNED.discrepancyPct,
                discrepancyFlagged: RETURNED.discrepancyFlagged,
              })
              .from(RETURNED)
              .innerJoin(DISPATCHED, eq(RETURNED.dispatchedContentId, DISPATCHED.id))
              .where(
                and(
                  eq(RETURNED.returnId, payload.returnId),
                  eq(DISPATCHED.dispatchId, dispatchRow.id),
                  eq(DISPATCHED.medicationOrderId, payload.medicationOrderId),
                ),
              )
              .limit(1);
            const row = rows[0];
            if (row) {
              returnedContent = {
                returnedContentId: row.returnedContentId,
                dispatchedContentId: row.dispatchedContentId,
                comfortKitTemplateMedicationId: row.comfortKitTemplateMedicationId,
                medicationOrderId: row.medicationOrderId,
                rxnorm: row.rxnorm,
                drugName: row.drugName,
                isControlledSubstance: row.isControlledSubstance,
                controlledSubstanceSchedule: row.controlledSubstanceSchedule,
                lotNumber: row.lotNumber,
                dispatchedQuantity: row.dispatchedQuantity,
                quantityReturned: row.quantityReturned,
                quantityDisposedAtHome: row.quantityDisposedAtHome,
                quantityUnaccounted: row.quantityUnaccounted,
                discrepancyPct: Number(row.discrepancyPct),
                discrepancyFlagged: row.discrepancyFlagged,
              };
            }
          }

          let custody: ControlledSubstanceCustodyChainFacts | null = null;
          const returnRows = await tx
            .select({
              retrievingMembershipId: RETURN.assignedRetrievingMembershipId,
              disposalWitnessMembershipId: RETURN.disposalWitnessMembershipId,
              reconciledByMembershipId: RETURN.reconciledByMembershipId,
            })
            .from(RETURN)
            .where(and(eq(RETURN.id, payload.returnId), eq(RETURN.organizationId, organizationId)))
            .limit(1);
          const returnRow = returnRows[0];
          if (returnRow) {
            custody = {
              retrievingMembershipId: returnRow.retrievingMembershipId,
              disposalWitnessMembershipId: returnRow.disposalWitnessMembershipId,
              reconciledByMembershipId: returnRow.reconciledByMembershipId,
            };
          }

          const action = decideControlledSubstanceReemit(
            payload,
            dispatchContext,
            returnedContent,
            custody,
          );
          if (action.kind !== "reemit" || !dispatchContext) return;

          await deps.outbox.publish(tx, {
            eventName: "m21.controlled_substance.discrepancy_detected",
            organizationId,
            aggregateKind: "comfort_kit_return",
            aggregateId: action.returnId,
            payload: {
              orgId: organizationId,
              patientId: dispatchContext.patientId,
              admissionId: dispatchContext.admissionId,
              providerEntityId: dispatchContext.providerEntityId,
              locationId: dispatchContext.locationId,
              returnId: action.returnId,
              dispatchId: action.dispatchId,
              m13DeploymentId: action.m13DeploymentId,
              detectionSource: action.detectionSource,
              discrepantMedications: [action.discrepantMedication],
              custodyChain: action.custodyChain,
              detectedAt: (deps.now?.() ?? new Date()).toISOString(),
            },
          });
        },
      );
    },
  };
}
