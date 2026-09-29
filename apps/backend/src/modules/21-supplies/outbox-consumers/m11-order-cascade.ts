// apps/backend/src/modules/21-supplies/outbox-consumers/m11-order-cascade.ts — M21's live binding for two
// of the three M11 cascade deciders in `../consumers/m11-orders.ts` (F-120, #248).
//
// `decideSupplyCancellationCascade` (§7.7) and `decideOrderDiscontinued` (§2.2 DME monthly-rental
// close-out) have been complete, exported and unit-tested since M21-T04, and their own file's header says
// "the live outbox binding + the transactional insert land with the §4.6 workers alongside the M21-T05
// service layer" — the service layer landed; nothing ever bound them. `m11.order.supply_cancellation_
// requested` and `m11.order.discontinued` are ALREADY EMITTED in production (the M11 discharge cascade,
// F-102, `consumers/bindings.ts`), so every discharge/death/revocation on an admission with an open
// `supply_request` has been cancelling the M11 order while leaving the DME rental or comfort-kit request
// standing — the reciprocal of F-102's own finding, one module downstream of the fix it landed.
//
// THE THIRD DECIDER, `decideSupplyFulfillmentIntake` (§7.1 — `m11.order.supply_fulfillment_requested`), IS
// STILL NOT BOUND HERE (F-166, #248 re-checked, not fixed). The "no platform seam answers the serving
// Location" framing that used to sit here was checked again rather than trusted and found STALE —
// `AdmissionSummary.locationId` was already on the `getAdmissionStatusReader` projection
// `../consumers/order-context.ts` calls for `admission`, unread; `../consumers/order-context.ts` and
// `../consumers/m11-orders.ts` now read it and the dead `resolveServingLocation` port is gone. Fixing that
// surfaced a DEEPER blocker underneath it: M21's D1 per-kind schemas (`@wardenx/supplies`) require fields
// — an M21 `supply_item` uuid + HCPCS code for `dme`, a full street-address snapshot for `dme`/`supply`, a
// per-medication `contents` array + `pharmacyDispatchMode` for `comfort_kit` — that M11's own order-data
// contract cannot supply for ANY of the three sub-kinds (`dme`/`supply` are `contract_not_published`
// unconstrained blobs; `comfort_kit`'s canonical M11 shape is `{kitSku, deploymentSite,
// preferredDeliveryWindow?, notes?}`, none of which are those fields), and no published M5 seam exposes a
// full street address either. A bound consumer would `ValidationError`-refuse essentially every real
// delivery — see `scripts/outbox-deferred-consumers.ts`'s m21 group for the full finding.
//
// WHY NOT `cancelSupplyRequest` / `M21WriteActor`. `routes/actor.ts`'s own doc comment is explicit: "the
// §4.5.1 inbound cascades reach M21 through the outbox consumers, not through a route, and they attribute
// their rows to the source event rather than to a human" — `writeActorOf` REFUSES a session with no
// membership, and fabricating one here would misattribute a system cascade to a person who did nothing on
// a DEA chain-of-custody-adjacent table. This binding runs `transitionSupplyRequest` + `patchSupplyRequest`
// directly (the same primitives `runRequestTransition` composes in `../routes/write-service-drizzle.ts`),
// with no actor at all.
//
// A `sourceOrderId` matches at most one live (non-terminal) `supply_request` in practice — the §7.1 intake
// decider treats a second delivery for the same order as an idempotent skip rather than a second row — but
// nothing in the schema enforces that, so this reads the MOST RECENTLY CREATED row rather than assuming
// uniqueness.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import type {
  DmeRentalCadence,
  IsoInstant,
  SupplyRequestKind,
  SupplyRequestStatus,
} from "@wardenx/types";
import { and, desc, eq } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import { patchSupplyRequest } from "../routes/write-service-drizzle";
import type { EffectPatch } from "../routes/effects-runner";
import type { OutboxEmission, WriteOutboxPort } from "../routes/write-service";
import {
  M11_ORDER_DISCONTINUED_EVENT,
  M11_SUPPLY_CANCELLATION_REQUESTED_EVENT,
  type M11OrderDiscontinuedPayload,
  type M11SupplyCancellationRequestedPayload,
  type SupplyCancellationTarget,
  type SupplyDiscontinuationTarget,
  decideOrderDiscontinued,
  decideSupplyCancellationCascade,
} from "../consumers/m11-orders";
import { transitionSupplyRequest } from "../lifecycle/index";

const REQUEST = schema.supplyRequest;

/** A consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

export interface M21OrderCascadeDeps {
  readonly db: DbClient;
  readonly outbox: WriteOutboxPort;
  readonly now?: () => Date;
}

/** The one row this binding cares about, keyed on `sourceOrderId`. Null when no live request ever named
 *  this order (the ordinary case until the §7.1 intake consumer lands — see the file header). */
async function loadTargetRow(
  tx: DbClient,
  organizationId: string,
  orderId: string,
): Promise<
  | (SupplyCancellationTarget & {
      readonly id: string;
      readonly data: unknown;
      readonly organizationId: string;
      readonly patientId: string;
      readonly admissionId: string;
      readonly providerEntityId: string;
      readonly locationId: string;
      readonly sourceOrderId: string | null;
    })
  | null
> {
  const rows = await tx
    .select()
    .from(REQUEST)
    .where(and(eq(REQUEST.organizationId, organizationId), eq(REQUEST.sourceOrderId, orderId)))
    .orderBy(desc(REQUEST.createdAt))
    .limit(1);
  const row = rows[0] as typeof REQUEST.$inferSelect | undefined;
  if (!row) return null;
  return {
    id: row.id,
    supplyRequestId: row.id,
    kind: row.kind as SupplyRequestKind,
    status: row.status as SupplyRequestStatus,
    data: row.data,
    organizationId: row.organizationId,
    patientId: row.patientId,
    admissionId: row.admissionId,
    providerEntityId: row.providerEntityId,
    locationId: row.locationId,
    sourceOrderId: row.sourceOrderId,
  };
}

function anchorOf(row: {
  readonly organizationId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
}) {
  return {
    orgId: row.organizationId,
    patientId: row.patientId,
    admissionId: row.admissionId,
    providerEntityId: row.providerEntityId,
    locationId: row.locationId,
  };
}

/**
 * M21's live `m11.order.supply_cancellation_requested` binding (§7.7).
 *
 * `decideSupplyCancellationCascade` needs only the target's kind/status — no Location, no routing, no
 * per-kind data — which is exactly why this half of the cascade is tractable today while the intake half
 * is not.
 */
export function buildM21SupplyCancellationConsumer(
  deps: M21OrderCascadeDeps,
): OutboxConsumerBinding {
  const now = deps.now ?? (() => new Date());
  return {
    consumerName: "m21.supply-cancellation-cascade",
    consumerModule: "m21",
    eventTypes: [M11_SUPPLY_CANCELLATION_REQUESTED_EVENT],
    async handle(event): Promise<void> {
      const payload = (event.payload ?? {}) as M11SupplyCancellationRequestedPayload;
      if (typeof payload.orderId !== "string") {
        throw new Error("m21.supply-cancellation-cascade: payload has no orderId");
      }
      const organizationId = event.organizationId;

      await withOrgContext(deps.db, { organizationId, userId: CONSUMER_USER_ID }, async (scoped) => {
        const tx = scoped as unknown as DbClient;
        const target = await loadTargetRow(tx, organizationId, payload.orderId);
        const action = decideSupplyCancellationCascade(payload, target);
        if (action.kind === "no_match" || action.kind === "already_cancelling") return;
        if (!target) return; // unreachable — every non-`no_match` action requires a resolved target

        const at = now();
        if (action.kind === "cancel_no_op") {
          await deps.outbox.publish(tx, {
            eventName: "m21.supply_request.cancel_no_op",
            organizationId,
            aggregateKind: "supply_request",
            aggregateId: target.id,
            payload: {
              orgId: organizationId,
              supplyRequestId: target.id,
              sourceOrderId: payload.orderId,
              terminalStatus: action.terminalStatus,
              occurredAt: at.toISOString(),
            },
          } satisfies OutboxEmission);
          return;
        }

        // `action.kind` is now `"cancel" | "request_cancellation"` — both pre-checked legal by
        // `decideSupplyCancellationCascade` against the SAME `canTransition` edge table
        // `transitionSupplyRequest` enforces, so this never throws `M21_INVALID_STATUS_TRANSITION` in
        // practice; it is still run (not assumed) so a future machine edge cannot silently drift from it.
        const preOrdered = action.kind === "cancel";
        const transition = transitionSupplyRequest(target.status, target.kind, {
          type: preOrdered ? "cancel" : "requestCancellation",
          reason: action.reason,
          at: at.toISOString() as IsoInstant,
        });
        const anchor = anchorOf(target);
        const payloads: Partial<Record<string, Record<string, unknown>>> = {
          "m21.supply_request.status_changed": {
            ...anchor,
            supplyRequestId: target.id,
            kind: target.kind,
            sourceOrderId: target.sourceOrderId,
            fromStatus: transition.from,
            toStatus: transition.to,
            occurredAt: at.toISOString(),
          },
        };
        if (preOrdered) {
          payloads["m21.supply_request.cancelled"] = {
            ...anchor,
            supplyRequestId: target.id,
            sourceOrderId: target.sourceOrderId,
            reason: action.reason,
            cancelledAt: at.toISOString(),
            requiredVendorConfirmation: false,
          };
        }
        for (const effect of transition.effects) {
          if (effect.kind !== "outbox") continue;
          const effectPayload = payloads[effect.event];
          if (!effectPayload) {
            throw new Error(
              `m21.supply-cancellation-cascade: transition emitted '${effect.event}' with no payload built`,
            );
          }
          await deps.outbox.publish(tx, {
            eventName: effect.event as OutboxEmission["eventName"],
            organizationId,
            aggregateKind: "supply_request",
            aggregateId: target.id,
            payload: effectPayload,
          });
        }
        const patch: EffectPatch = {};
        for (const effect of transition.effects) {
          if (effect.kind === "set_timestamp") {
            if (effect.field === "cancelled_at") patch.cancelledAt = new Date(effect.at);
            if (effect.field === "cancellation_pending_at")
              patch.cancellationPendingAt = new Date(effect.at);
          }
          if (effect.kind === "record_cancellation") {
            patch.cancellationReason = effect.reason;
          }
        }
        await patchSupplyRequest(tx as Parameters<typeof patchSupplyRequest>[0], target.id, transition.to, patch, at);
      });
    },
  };
}

/**
 * M21's live `m11.order.discontinued` binding (§2.2 — the DME monthly-rental close-out). M21 subscribes to
 * M11's broad close-out fan-out for exactly the one reason `decideOrderDiscontinued`'s own doc names: a
 * `monthly` DME rental waits on M11 discontinuing the order (rather than a delivery) to stop its recurring
 * HCPCS accrual. Every other kind self-completes and this is an ordinary `no_op`, not a fault.
 */
export function buildM21OrderDiscontinuedConsumer(
  deps: M21OrderCascadeDeps,
): OutboxConsumerBinding {
  const now = deps.now ?? (() => new Date());
  return {
    consumerName: "m21.order-discontinued-rental-closeout",
    consumerModule: "m21",
    eventTypes: [M11_ORDER_DISCONTINUED_EVENT],
    async handle(event): Promise<void> {
      const payload = (event.payload ?? {}) as M11OrderDiscontinuedPayload;
      if (typeof payload.orderId !== "string") {
        throw new Error("m21.order-discontinued-rental-closeout: payload has no orderId");
      }
      const organizationId = event.organizationId;

      await withOrgContext(deps.db, { organizationId, userId: CONSUMER_USER_ID }, async (scoped) => {
        const tx = scoped as unknown as DbClient;
        const row = await loadTargetRow(tx, organizationId, payload.orderId);
        const target: SupplyDiscontinuationTarget | null =
          row === null
            ? null
            : {
                supplyRequestId: row.id,
                kind: row.kind,
                status: row.status,
                rentalCadence:
                  row.kind === "dme"
                    ? (((row.data ?? {}) as { rentalCadence?: DmeRentalCadence }).rentalCadence ??
                      null)
                    : null,
              };
        const action = decideOrderDiscontinued(payload, target);
        if (action.kind === "no_op" || row === null) return;

        const at = now();
        const transition = transitionSupplyRequest(row.status, row.kind, {
          type: "completeRequest",
          at: at.toISOString() as IsoInstant,
          rentalCadence: target?.rentalCadence ?? null,
          orderDiscontinued: true,
        });
        const anchor = anchorOf(row);
        for (const effect of transition.effects) {
          if (effect.kind !== "outbox") continue;
          if (effect.event !== "m21.supply_request.status_changed") {
            throw new Error(
              `m21.order-discontinued-rental-closeout: transition emitted '${effect.event}' with no payload built`,
            );
          }
          await deps.outbox.publish(tx, {
            eventName: effect.event as OutboxEmission["eventName"],
            organizationId,
            aggregateKind: "supply_request",
            aggregateId: row.id,
            payload: {
              ...anchor,
              supplyRequestId: row.id,
              kind: row.kind,
              sourceOrderId: row.sourceOrderId,
              fromStatus: transition.from,
              toStatus: transition.to,
              occurredAt: at.toISOString(),
            },
          });
        }
        const patch: EffectPatch = {};
        for (const effect of transition.effects) {
          if (effect.kind === "set_timestamp" && effect.field === "completed_at") {
            patch.completedAt = new Date(effect.at);
          }
        }
        await patchSupplyRequest(tx as Parameters<typeof patchSupplyRequest>[0], row.id, transition.to, patch, at);
      });
    },
  };
}
