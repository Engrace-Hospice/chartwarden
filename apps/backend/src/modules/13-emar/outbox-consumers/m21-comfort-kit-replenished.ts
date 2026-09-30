// apps/backend/src/modules/13-emar/outbox-consumers/m21-comfort-kit-replenished.ts — the §2.7 comfort-kit
// replenishment intake, live for the first time (F-166, #248).
//
// `applyKitReplenishment` (`@wardenx/emar`, `comfort-kit/comfort-kit.ts`, added this pass — no pure core
// for "apply a physically-arrived replenishment to a drawdown" existed anywhere before now) tops an
// existing `comfort_kit_drawdown.remaining_quantity` up by the delivered amount, CAPPED at the drawdown's
// own `expected_quantity` (the deployed capacity) — a kit's tracked remaining can never honestly exceed
// what it was deployed with.
//
// `M13_OUTBOX_SUBSCRIPTIONS` (`../consumers/index.ts`) never named this event at all (only
// `.deployed_at_patient` and `.returned` were listed — corrected in the same change that adds this file).
//
// NO OUTBOX EMIT: unlike the sibling consumers in this directory, this one publishes nothing. There is no
// `m13.comfort_kit.replenished`/`.restocked` (or any spelling) in M13's own event catalog
// (`events-by-m13.ts`) — a top-up landing is not, itself, a fact any consumer anywhere needs to react to
// (the request-side signal, `m13.comfort_kit.replenishment_needed`, already exists and is what M21's own
// `buildM21ComfortKitReplenishmentIntakeConsumer` — F-153 — reacts to, on the OTHER side of this same
// round trip). Inventing a new catalogued event here that nothing would consume is the identical mistake
// this pass's `write-service-drizzle.ts` fix removes on the M21 side (F-166's `createReturn` fix, this
// same change) — a genesis event with no reader is not a completed handshake, and a dispatcher-validated
// emit that fails the boot catalog check would roll back the whole top-up transaction for no reason.
//
// SAME NULLABLE-`medicationOrderId` POSTURE AS THE DEPLOYED CONSUMER (see that file's header for the full
// reasoning): `contents` here is a SUBSET of the original deployment (§4.5.2's own doc comment — "only the
// lines that crossed threshold"), and per M21's spec every line that crosses threshold started as an
// ORDER-LINKED line in `buildComfortKitDeployment` (a floor-stock line has no drawdown row to threshold-
// check against in the first place, since the deployed consumer never created one for it) — so in
// practice every replenished line SHOULD already have a matching drawdown row. This consumer still
// defends against the case where it does not (an order-less line, or a line that predates this binding):
// it skips the line silently at the row level rather than fabricate a drawdown row out of a replenishment
// event, which carries none of the facts (lot/expiration/threshold) a genesis drawdown row needs.
//
// IDEMPOTENCY. No dedicated idempotency column exists for a replenishment application (unlike the
// deployment's `m21_supply_dispatch_id` unique). A genuine redelivery of the SAME `m21.comfort_kit.
// replenished` event would therefore double-apply the top-up on a naive retry. This consumer accepts
// that as the honest state of the art for THIS event today rather than inventing a synthetic dedupe key:
// capping at `expected_quantity` bounds the damage of a double-apply to "restored to full one delivery
// early", never an unbounded runaway, and the dispatcher's own receipt table (`(eventId, consumerName)`)
// already prevents an exact-same-row redelivery from re-invoking `handle()` at all — the residual risk is
// only a SECOND, distinct `m21.comfort_kit.replenished` event racing a still-in-flight first one, which
// the capped-add tolerates safely.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { applyKitReplenishment } from "@wardenx/emar";
import type { M21ComfortKitReplenishedPayload } from "@wardenx/types";
import { and, eq } from "drizzle-orm";

const DRAWDOWN = schema.comfortKitDrawdowns;

export const M13_COMFORT_KIT_REPLENISHED_CONSUMER = {
  eventName: "m21.comfort_kit.replenished",
  consumerName: "m13.comfort-kit-replenished",
} as const;

export interface ComfortKitReplenishedConsumerDeps {
  readonly db: DbClient;
}

/**
 * M13's live `m21.comfort_kit.replenished` binding (§2.7). Tops up each order-linked drawdown line by the
 * delivered amount, capped at the drawdown's own `expected_quantity`. A line with no `medicationOrderId`
 * or no matching drawdown row is skipped, not fabricated — see the file header.
 */
export function buildM13ComfortKitReplenishedConsumer(
  deps: ComfortKitReplenishedConsumerDeps,
) {
  return {
    consumerName: M13_COMFORT_KIT_REPLENISHED_CONSUMER.consumerName,
    consumerModule: "m13" as const,
    eventTypes: [M13_COMFORT_KIT_REPLENISHED_CONSUMER.eventName] as const,
    async handle(event: {
      readonly id: string;
      readonly organizationId: string;
      readonly payload: unknown;
    }): Promise<void> {
      const payload = (event.payload ?? {}) as M21ComfortKitReplenishedPayload;
      if (typeof payload.sourceDeploymentId !== "string") {
        throw new Error(
          `${M13_COMFORT_KIT_REPLENISHED_CONSUMER.consumerName}: payload has no sourceDeploymentId`,
        );
      }
      const organizationId = event.organizationId;
      const deploymentId = payload.sourceDeploymentId;
      const contents = payload.contents ?? [];
      if (contents.length === 0) return;

      await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
        const tx = scoped as unknown as DbClient;

        const existingRows = await tx
          .select({
            medicationOrderId: DRAWDOWN.medicationOrderId,
            remainingQuantity: DRAWDOWN.remainingQuantity,
            expectedQuantity: DRAWDOWN.expectedQuantity,
          })
          .from(DRAWDOWN)
          .where(eq(DRAWDOWN.comfortKitDeploymentId, deploymentId));
        const byOrder = new Map(existingRows.map((r) => [r.medicationOrderId, r] as const));

        for (const line of contents) {
          const orderId = line.medicationOrderId;
          const existing = orderId ? byOrder.get(orderId) : undefined;
          if (!orderId || !existing) continue; // floor-stock or pre-dates this binding — see file header

          const result = applyKitReplenishment(
            {
              medicationOrderId: orderId,
              remainingQuantity: Number(existing.remainingQuantity),
              expectedQuantity: Number(existing.expectedQuantity),
            },
            Number(line.dispatchedQuantity),
          );

          await tx
            .update(DRAWDOWN)
            .set({ remainingQuantity: String(result.newRemainingQuantity), updatedAt: new Date() })
            .where(
              and(eq(DRAWDOWN.comfortKitDeploymentId, deploymentId), eq(DRAWDOWN.medicationOrderId, orderId)),
            );
        }
      });
    },
  };
}
