// apps/backend/src/modules/13-emar/outbox-consumers/m21-comfort-kit-returned.ts — the §2.6 comfort-kit
// disposal-status flip, live for the first time (F-166, #248).
//
// `applyKitReturn` (`@chartwarden/emar`, `comfort-kit/comfort-kit.ts`) has been a complete, pure, unit-tested
// core since M13-T05, and `M13_OUTBOX_SUBSCRIPTIONS` (`../consumers/index.ts`) has named
// `m21.comfort_kit.returned` with a real consumer (`m13.comfort-kit-returned`) since the list was written
// — nothing has ever bound it. Two things had to be fixed BEFORE this could bind honestly:
//
//   1. `write-service-drizzle.ts`'s `createReturn` published this SAME event name at the moment a return
//      was merely REQUESTED (state stays "requested"), with `disposalMethod`/`reconciledByMembershipId`
//      as placeholder empty strings — nothing had happened yet. A consumer bound to `.returned` would
//      have flipped `comfort_kit_deployment.disposal_status='returned'` the instant a return was opened,
//      before anyone retrieved or reconciled anything. Fixed at the source (this same change): that
//      emission is deleted, and the only real emission left is `reconcileReturn`'s own
//      `{ kind: "outbox", event: "m21.comfort_kit.returned" }` effect (`../21-supplies/lifecycle/
//      return.ts`), which fires once the return actually reaches `reconciled`.
//   2. `comfort_kit_deployment` had never been written by anything (F-166's sibling `m21-comfort-kit-
//      deployed.ts` consumer is what creates the row this one updates).
//
// THIS CONSUMER DOES ONLY THE DISPOSAL-STATUS FLIP, not the per-line drawdown close — that is the
// SEPARATE `m21.comfort_kit.return_reconciliation` event (`m21-comfort-kit-return-reconciliation.ts`,
// same pass), which carries the full per-line accounting `.returned`'s own catalog description says rides
// on the other event "so a consumer that only needs the disposal fact does not have to parse the
// manifest." `m13.comfort_kit.returned` (M13's own outbound ack of the whole return) is emitted from the
// RECONCILIATION consumer, not this one — it needs `finalRemainingByMedication`, which only that consumer
// computes. Both M21 events fire in the SAME transaction (`reconcileReturn`'s effects array), but arrive
// as independent outbox deliveries with no ordering guarantee between them; each consumer here writes
// disjoint columns (`disposal_status`/`returned_at` here, `final_remaining_quantity_at_return`/
// `disposal_reconciliation_status` there) so there is no race between them either way.
//
// IDEMPOTENCY WITHOUT A VERSION COLUMN (the `m6-admission-discharged-cascade.ts` precedent): the UPDATE's
// WHERE conditions on `disposal_status != 'returned'`, so a redelivery after the first commit matches zero
// rows and is a silent no-op rather than re-stamping `returned_at`.
import { type DbClient, schema } from "@chartwarden/db";
import { applyKitReturn } from "@chartwarden/emar";
import { withOrgContext } from "@chartwarden/tenancy";
import type { M21ComfortKitReturnedPayload } from "@chartwarden/types";
import { and, eq, ne } from "drizzle-orm";

const DEPLOYMENT = schema.comfortKitDeployments;

export const M13_COMFORT_KIT_RETURNED_CONSUMER = {
  eventName: "m21.comfort_kit.returned",
  consumerName: "m13.comfort-kit-returned",
} as const;

export interface ComfortKitReturnedConsumerDeps {
  readonly db: DbClient;
}

/** M13's live `m21.comfort_kit.returned` binding (§2.6) — flips `comfort_kit_deployment.disposal_status`
 *  to `'returned'` and stamps `returned_at`. */
export function buildM13ComfortKitReturnedConsumer(deps: ComfortKitReturnedConsumerDeps) {
  return {
    consumerName: M13_COMFORT_KIT_RETURNED_CONSUMER.consumerName,
    consumerModule: "m13" as const,
    eventTypes: [M13_COMFORT_KIT_RETURNED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const payload = (event.payload ?? {}) as M21ComfortKitReturnedPayload;
      if (typeof payload.m13DeploymentId !== "string") {
        throw new Error(
          `${M13_COMFORT_KIT_RETURNED_CONSUMER.consumerName}: payload has no m13DeploymentId`,
        );
      }
      const organizationId = event.organizationId;
      const deploymentId = payload.m13DeploymentId;
      const result = applyKitReturn({ deploymentId, returnedAt: payload.reconciledAt });

      await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as unknown as DbClient;
        await tx
          .update(DEPLOYMENT)
          .set({ disposalStatus: result.disposalStatus, returnedAt: new Date(result.returnedAt) })
          .where(and(eq(DEPLOYMENT.id, deploymentId), ne(DEPLOYMENT.disposalStatus, "returned")));
      });
    },
  };
}
