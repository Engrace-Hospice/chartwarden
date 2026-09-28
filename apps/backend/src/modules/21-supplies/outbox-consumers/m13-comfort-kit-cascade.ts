// apps/backend/src/modules/21-supplies/outbox-consumers/m13-comfort-kit-cascade.ts — M21's live binding
// for two of the four `../consumers/m13-comfort-kit.ts` deciders (F-141/#248's m21 group, this pass).
//
// `decideDeploymentAck` (§2.5) and `decideReturnRequired` (§2.6) have been complete, exported and
// unit-tested since M21-T04, and both are named on M21's own `M21_SUBSCRIBED_EVENT_NAMES`
// (packages/types/src/supplies.ts) — nothing has ever bound either to the dispatcher.
//
// THE OTHER TWO M13 DECIDERS ARE NOT BOUND HERE, for two DIFFERENT reasons, neither of which is "not
// gotten to yet":
//   • `decideReplenishmentIntake` (§2.1) needs the SAME shared `insertRequest` write path
//     `write-service-drizzle.ts`'s `createDirect` seam method calls — extracting that closure to module
//     scope (the `patchSupplyRequest` precedent, F-102) is a shared-file change belonging with the rest of
//     this arc's centralized wiring, not an isolated new file.
//   • `decideControlledSubstanceReemit` (§4.5.1) is genuinely payload-BLOCKED, not merely unbound: the
//     catalogued `m21.controlled_substance.discrepancy_detected` schema (events-by-m21.ts) requires a
//     non-nullable `returnId` plus a full `custodyChain` (retrieving/disposal-witness/reconciled
//     membership ids) — the shape a RECONCILIATION-time discrepancy carries. M13's bedside re-emit fires
//     at drug ADMINISTRATION time, before any `comfort_kit_return` row exists; the decider's own
//     `ReemittedDiscrepantLine` correctly carries none of those fields. Binding it today means either
//     inventing a `returnId` (fabricating chain-of-custody evidence on a DEA perpetual log — the exact
//     mistake F-102's `providerEntityFor` lesson warns against) or widening the catalog schema to make
//     `returnId`/`custodyChain` optional for this one `detectionSource`, which is a producer-side contract
//     change affecting every consumer of this event (M30/M33/M36 via `seamConsumers`) and needs its own
//     scoped pass, not a bind.
//
// TWO SEAMS TO ONE OUTCOME. `linkM13Deployment` and the return-open both run with NO acting membership —
// the `m11-order-cascade.ts` / F-102 `CONSUMER_USER_ID` convention — because both cascades are M13
// telling M21 something happened, not a human acting on the row.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { RETURN_WINDOW_HOURS_DEFAULT } from "@wardenx/supplies";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import { transitionComfortKitDispatch } from "../lifecycle/index";
import {
  M13_COMFORT_KIT_DEPLOYED_EVENT,
  M13_RETURN_REQUIRED_EVENT,
  type ComfortKitDispatchContext,
  type M13ComfortKitDeployedPayload,
  type M13ReturnRequiredPayload,
  decideDeploymentAck,
  decideReturnRequired,
} from "../consumers/m13-comfort-kit";

const DISPATCH = schema.comfortKitDispatch;
const DISPATCHED = schema.comfortKitDispatchedContent;
const RETURN = schema.comfortKitReturn;

/** A consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

export interface M21ComfortKitCascadeDeps {
  readonly db: DbClient;
  readonly now?: () => Date;
  readonly returnWindowHours?: number;
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

      await withOrgContext(deps.db, { organizationId, userId: CONSUMER_USER_ID }, async (scoped) => {
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
          const containsControlledSubstance = await dispatchContainsControlledSubstance(tx, row.id);
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
      });
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

      await withOrgContext(deps.db, { organizationId, userId: CONSUMER_USER_ID }, async (scoped) => {
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
      });
    },
  };
}
