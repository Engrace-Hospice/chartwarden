// apps/backend/src/modules/21-supplies/outbox-consumers/m11-supply-fulfillment-intake.ts — M21's live
// binding for `m11.order.supply_fulfillment_requested` (§7.1 / §4.5.1), the THIRD and last of the M11 cascade
// deciders in `../consumers/m11-orders.ts` (F-232, #248; F-229 stopped here for want of an order contract).
//
// WHAT MAKES IT BINDABLE NOW. F-229 named the gaps: M11 published no field-level `dme`/`supply` contract and
// M5 exposed no street address. F-232 closes both (user-approved Option A): `dme.v2` / `supply.v2`
// (`@chartwarden/orders`, `{skuId, quantity, ...}`, CLOSED — no address, no HCPCS on the order) and
// `PatientAddressReader.primaryAddress`. Everything else the `supply_request` needs is READ, not guessed:
//   • patient / admission / provider entity / serving Location — `resolveSupplyOrderContext` (M11 + M6 seams);
//   • `hcpcs` (+ `unit` for a supply that omits one) — the M21 `supply_item` row the order's `skuId` names;
//   • `deliveryAddress` — PULLED through M5's seam at consume time and snapshotted into `data` with a fresh
//     `capturedAt`. It never rides the outbox (the event carries ids + `supplyDetail` only).
//
// `comfort_kit` IS NOT BOUND HERE, deliberately. Its M11 `kitSku` is free text with no mapping to a
// `comfort_kit_template`, the D1 `contents` array (per-medication lines) cannot be derived from the order,
// and `snf`/`ipu` sites need an `ipuRoomId` M11 never captures. A comfort_kit delivery SETTLES with reason
// `comfort_kit_contract_not_published` (no retry loop, no invented data) — the status quo for that kind.
//
// SETTLE vs RETRY (the M6 `m11-recertification-signed` convention: a deterministic, non-self-healing no-op is
// a settle — a returned outcome; a thing a retry can fix is a throw):
//   SETTLE: `invalid_payload`, `comfort_kit_contract_not_published`, `order_contract_unresolved` (supplyDetail
//     is not a valid `<kind>.v2`, e.g. a v1 open-blob order), `sku_unresolved` (unknown/inactive/retired SKU,
//     or a `dme` SKU with no HCPCS), `address_unresolved` (no primary address on file, or no 2-letter state),
//     `request_data_invalid` (the assembled row fails its D1 schema — violation PATHS only, never values,
//     because the payload is PHI-adjacent), `already_applied` (idempotent on `sourceOrderId`).
//   THROW (retry, then dead-letter): the decider's own `M21_SOURCE_ORDER_UNRESOLVED` /
//     `M21_SERVING_LOCATION_UNRESOLVED` — an ordering/configuration failure a later delivery can clear; a
//     row anchored to a guessed Location misroutes a dispatch.
// A settle leaves NO `supply_request`, so M11's order waits for a coordinator to act on it by hand; the
// outcome is returned (and asserted by the live suite) rather than silently dropped.
//
// SEAM CALLS ARE OUTSIDE THE TRANSACTION. Every seam read opens its own org context; calling one from inside
// ours would hold two pooled connections per delivery and self-deadlock the pool under concurrency (the same
// reason `write-service-drizzle.ts`'s `assignVendor` hoists its M40 probe). Only the SKU read and the insert
// share one transaction, guarded by a per-order advisory lock + an in-transaction re-check of
// `sourceOrderId`, so two concurrent deliveries for one order cannot both insert (the schema has no unique
// constraint on `source_order_id`, per the cascade file's own header).
//
// AMBIENT REQUEST CONTEXT. `OrderProvider.getOrder` (M11's Drizzle store) opens `withOrgContextFromRequest`,
// which throws outside a `runWithRequestContext` scope — a dispatcher tick is not a request (the M16
// `m39-consent-signed` / M19 / M20 precedent). The binding runs the whole delivery inside
// `runWithRequestContext({organizationId, userId: CONSUMER_USER_ID}, …)`; without it the decider's inputs
// never resolve and every delivery would retry into the dead-letter queue. Proven live (the suite registers
// the REAL Drizzle seams and delivers through the REAL dispatcher).
//
// NO ACTING MEMBERSHIP (F-102 `CONSUMER_USER_ID`): `requestedByMembershipId: null` and
// `emitCreatedFromExternal: false` (§7.1 acceptance 3) — a system cascade must not claim a human origin.
import { type DbClient, schema } from "@chartwarden/db";
import { validateOrderData } from "@chartwarden/orders";
import { validateSupplyRequestData } from "@chartwarden/supplies";
import { runWithRequestContext, withOrgContext } from "@chartwarden/tenancy";
import type { IsoInstant, OrderRecordId, PatientAddressReader } from "@chartwarden/types";
import { and, desc, eq, sql } from "drizzle-orm";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import {
  type M11SupplyFulfillmentRequestedPayload,
  M11_SUPPLY_FULFILLMENT_REQUESTED_EVENT,
  type SupplyFulfillmentIntakeAction,
  type SupplyFulfillmentIntakeFacts,
  type SupplyRequestDraft,
  decideSupplyFulfillmentIntake,
} from "../consumers/m11-orders";
import { type SupplyIntakePorts, resolveSupplyOrderContext } from "../consumers/order-context";
import { transitionSupplyRequest } from "../lifecycle/index";
import type { EffectPatch } from "../routes/effects-runner";
import type { OutboxEmission, WriteOutboxPort } from "../routes/write-service";
import { insertSupplyRequest, patchSupplyRequest } from "../routes/write-service-drizzle";
import { getPatientAddressReader } from "../seams/consumed";

const REQUEST = schema.supplyRequest;
const SUPPLY_ITEM = schema.supplyItem;

/** A consumer-driven write names no acting membership (the F-102 `CONSUMER_USER_ID` convention). */
const CONSUMER_USER_ID = "";

export const M21_SUPPLY_FULFILLMENT_INTAKE_CONSUMER = "m21.supply-fulfillment-intake";

export interface M21SupplyFulfillmentIntakeDeps {
  readonly db: DbClient;
  readonly outbox: WriteOutboxPort;
  readonly now?: () => Date;
  /** Test seam: defaults to the M5 `PatientAddressReader` resolved through the seam registry. */
  readonly addressReader?: () => PatientAddressReader;
  /** Test seam: defaults to {@link resolveSupplyOrderContext} (M11 + M6 seam reads). */
  readonly resolveFacts?: (
    organizationId: string,
    payload: M11SupplyFulfillmentRequestedPayload,
    ports: SupplyIntakePorts,
  ) => Promise<SupplyFulfillmentIntakeFacts>;
}

/** Why a delivery settled without writing a row (the live suite asserts these tokens). */
export type SupplyIntakeSettleReason =
  | "invalid_payload"
  | "comfort_kit_contract_not_published"
  | "already_applied"
  | "order_contract_unresolved"
  | "sku_unresolved"
  | "address_unresolved"
  | "request_data_invalid";

export type SupplyIntakeOutcome =
  | {
      readonly kind: "settled";
      readonly reason: SupplyIntakeSettleReason;
      readonly detail?: string;
    }
  | { readonly kind: "opened"; readonly supplyRequestId: string; readonly cancelled: boolean };

type OrderV2Detail = {
  readonly skuId: string;
  readonly quantity: number;
  readonly unit?: string;
  readonly rentalCadence?: "monthly" | "one_time_purchase";
  readonly needsInstallation?: boolean;
  readonly needsPatientEducation?: boolean;
};

interface SkuFacts {
  readonly hcpcs: string | null;
  readonly defaultUnit: string;
}

/** The newest `supply_request` for this order, or null — the idempotency probe (`findRequestBySourceOrder`). */
async function findRequestBySourceOrder(
  tx: DbClient,
  organizationId: string,
  orderId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ id: REQUEST.id })
    .from(REQUEST)
    .where(and(eq(REQUEST.organizationId, organizationId), eq(REQUEST.sourceOrderId, orderId)))
    .orderBy(desc(REQUEST.createdAt))
    .limit(1);
  return (rows[0] as { id: string } | undefined)?.id ?? null;
}

/**
 * Run one delivery. Exported so the live suite can assert the exact settle reason; the binding below just
 * discards the outcome (a settle and an `opened` both mean "this delivery is done").
 */
export function runSupplyFulfillmentIntake(
  deps: M21SupplyFulfillmentIntakeDeps,
  organizationId: string,
  rawPayload: unknown,
): Promise<SupplyIntakeOutcome> {
  return runWithRequestContext({ organizationId, userId: CONSUMER_USER_ID }, () =>
    intake(deps, organizationId, rawPayload),
  );
}

async function intake(
  deps: M21SupplyFulfillmentIntakeDeps,
  organizationId: string,
  rawPayload: unknown,
): Promise<SupplyIntakeOutcome> {
  const now = deps.now ?? (() => new Date());
  const payload = (rawPayload ?? {}) as Partial<M11SupplyFulfillmentRequestedPayload>;
  if (
    typeof payload.orderId !== "string" ||
    (payload.kind !== "dme" && payload.kind !== "supply" && payload.kind !== "comfort_kit")
  ) {
    return { kind: "settled", reason: "invalid_payload" };
  }
  if (payload.kind === "comfort_kit") {
    return { kind: "settled", reason: "comfort_kit_contract_not_published" };
  }
  const typed = payload as M11SupplyFulfillmentRequestedPayload;
  const orderKind = typed.kind as "dme" | "supply";

  // 1. Facts (M11 + M6 seam reads, each in its own org context) + the decider.
  const ports: SupplyIntakePorts = {
    findRequestBySourceOrder: (orderId) =>
      withOrgContext(deps.db, { organizationId, userId: CONSUMER_USER_ID }, (scoped) =>
        findRequestBySourceOrder(scoped as unknown as DbClient, organizationId, orderId),
      ),
  };
  const facts = await (deps.resolveFacts ?? resolveSupplyOrderContext)(
    organizationId,
    typed,
    ports,
  );
  const action: SupplyFulfillmentIntakeAction = decideSupplyFulfillmentIntake(typed, facts);
  if (action.kind === "idempotent_skip") return { kind: "settled", reason: "already_applied" };
  const draft: SupplyRequestDraft = action.draft;

  // 2. The order's contract. `supplyDetail` must be a valid `<kind>.v2`; a v1 open blob is not a contract.
  const findings = validateOrderData(orderKind, `${orderKind}.v2`, typed.supplyDetail);
  if (findings.length > 0) {
    return {
      kind: "settled",
      reason: "order_contract_unresolved",
      detail: findings.map((f) => f.field).join(","),
    };
  }
  const detail = typed.supplyDetail as OrderV2Detail;

  // 3. The SKU (platform catalog — read-all under RLS for active rows). Short, separate transaction.
  const at = now();
  const sku: SkuFacts | null = await withOrgContext(
    deps.db,
    { organizationId, userId: CONSUMER_USER_ID },
    async (scoped) => {
      const tx = scoped as unknown as DbClient;
      const rows = await tx
        .select({
          hcpcs: SUPPLY_ITEM.hcpcs,
          defaultUnit: SUPPLY_ITEM.defaultUnit,
          isActive: SUPPLY_ITEM.isActive,
          effectiveFrom: SUPPLY_ITEM.effectiveFrom,
          effectiveTo: SUPPLY_ITEM.effectiveTo,
        })
        .from(SUPPLY_ITEM)
        .where(eq(SUPPLY_ITEM.id, detail.skuId))
        .limit(1);
      const row = rows[0] as
        | {
            hcpcs: string | null;
            defaultUnit: string;
            isActive: boolean;
            effectiveFrom: Date;
            effectiveTo: Date | null;
          }
        | undefined;
      if (!row || !row.isActive) return null;
      if (row.effectiveFrom > at || (row.effectiveTo !== null && row.effectiveTo <= at))
        return null;
      return { hcpcs: row.hcpcs, defaultUnit: row.defaultUnit };
    },
  );
  if (sku === null) return { kind: "settled", reason: "sku_unresolved" };
  // §2.1: every DME line is billable and its schema requires `hcpcs`; a supply's is optional.
  if (orderKind === "dme" && (sku.hcpcs === null || sku.hcpcs === "")) {
    return { kind: "settled", reason: "sku_unresolved", detail: "dme_sku_has_no_hcpcs" };
  }

  // 4. The address — PULLED through M5's seam (own org context), never read off the event.
  const address = await (deps.addressReader ?? getPatientAddressReader)().primaryAddress(
    organizationId,
    draft.patientId,
  );
  if (address === null || address.state === null || address.state === "") {
    // No primary address on file, or a non-US one with no 2-letter state (the D1 snapshot requires it).
    return { kind: "settled", reason: "address_unresolved" };
  }
  const capturedAt: IsoInstant = at.toISOString();
  const deliveryAddress = {
    line1: address.line1,
    ...(address.line2 ? { line2: address.line2 } : {}),
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    ...(address.county ? { county: address.county } : {}),
    capturedAt,
  };

  // 5. Assemble the D1 `data` from READ facts only. Nothing clinical is invented: `hcpcsModifiers` is the
  //    empty array (none asserted at intake — M21's schema requires the array, the order names none).
  const data: Record<string, unknown> =
    orderKind === "dme"
      ? {
          skuId: detail.skuId,
          hcpcs: sku.hcpcs,
          hcpcsModifiers: [],
          quantity: detail.quantity,
          ...(detail.rentalCadence ? { rentalCadence: detail.rentalCadence } : {}),
          deliveryAddress,
          needsInstallation: detail.needsInstallation ?? false,
          needsPatientEducation: detail.needsPatientEducation ?? false,
        }
      : {
          skuId: detail.skuId,
          ...(sku.hcpcs ? { hcpcs: sku.hcpcs } : {}),
          quantity: detail.quantity,
          unit: detail.unit ?? sku.defaultUnit,
          deliveryAddress,
        };
  const validation = validateSupplyRequestData(draft.kind, data);
  if (!validation.ok) {
    // Paths only: a violation message can echo a value, and `data` holds a street address.
    return {
      kind: "settled",
      reason: "request_data_invalid",
      detail: validation.violations.map((v) => v.path).join(","),
    };
  }

  // 6. Insert (and, for a post-care posture, cancel in the SAME transaction).
  return withOrgContext(deps.db, { organizationId, userId: CONSUMER_USER_ID }, async (scoped) => {
    const tx = scoped as unknown as DbClient;
    // Serialize concurrent deliveries for one order, then re-check: the probe in step 1 ran in another
    // transaction, and `source_order_id` has no unique constraint to catch a race.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`m21-intake:${typed.orderId}`}))`);
    if ((await findRequestBySourceOrder(tx, organizationId, typed.orderId)) !== null) {
      return { kind: "settled", reason: "already_applied" } as const;
    }

    const created = await insertSupplyRequest(
      tx as unknown as Parameters<typeof insertSupplyRequest>[0],
      deps.outbox,
      {
        organizationId,
        patientId: draft.patientId,
        admissionId: draft.admissionId,
        locationId: draft.locationId,
        providerEntityId: draft.providerEntityId,
        kind: draft.kind,
        data,
        sourceOrderId: draft.sourceOrderId as OrderRecordId,
        sourceReplenishmentEventId: null,
        requestedByMembershipId: null,
        deliveryInstructions: null,
        at,
        // §7.1 acceptance 3 — an internal cascade is not an external creation.
        emitCreatedFromExternal: false,
      },
    );

    if (action.kind !== "open_and_cancel_request") {
      return { kind: "opened", supplyRequestId: created.id, cancelled: false } as const;
    }

    // §7.1 edges 3/4 — the patient died / was discharged between M11's emit and this consume: the row is
    // created and immediately cancelled with the reason recorded, so M11 gets its release event.
    const transition = transitionSupplyRequest("requested", draft.kind, {
      type: "cancel",
      reason: action.cancellationReason,
      at: capturedAt,
    });
    const anchor = {
      orgId: organizationId,
      patientId: draft.patientId,
      admissionId: draft.admissionId,
      providerEntityId: draft.providerEntityId,
      locationId: draft.locationId,
    };
    const payloads: Partial<Record<string, Record<string, unknown>>> = {
      "m21.supply_request.status_changed": {
        ...anchor,
        supplyRequestId: created.id,
        kind: draft.kind,
        sourceOrderId: draft.sourceOrderId,
        fromStatus: transition.from,
        toStatus: transition.to,
        occurredAt: at.toISOString(),
      },
      "m21.supply_request.cancelled": {
        ...anchor,
        supplyRequestId: created.id,
        sourceOrderId: draft.sourceOrderId,
        reason: action.cancellationReason,
        cancelledAt: at.toISOString(),
        requiredVendorConfirmation: false,
      },
    };
    for (const effect of transition.effects) {
      if (effect.kind !== "outbox") continue;
      const effectPayload = payloads[effect.event];
      if (!effectPayload) {
        throw new Error(
          `${M21_SUPPLY_FULFILLMENT_INTAKE_CONSUMER}: transition emitted '${effect.event}' with no payload built`,
        );
      }
      await deps.outbox.publish(tx, {
        eventName: effect.event as OutboxEmission["eventName"],
        organizationId,
        aggregateKind: "supply_request",
        aggregateId: created.id,
        payload: effectPayload,
      });
    }
    const patch: EffectPatch = {};
    for (const effect of transition.effects) {
      if (effect.kind === "set_timestamp" && effect.field === "cancelled_at") {
        patch.cancelledAt = new Date(effect.at);
      }
      if (effect.kind === "record_cancellation") patch.cancellationReason = effect.reason;
    }
    await patchSupplyRequest(
      tx as Parameters<typeof patchSupplyRequest>[0],
      created.id,
      transition.to,
      patch,
      at,
    );
    return { kind: "opened", supplyRequestId: created.id, cancelled: true } as const;
  });
}

/** M21's live `m11.order.supply_fulfillment_requested` binding (§7.1 / §4.5.1). */
export function buildM21SupplyFulfillmentIntakeConsumer(
  deps: M21SupplyFulfillmentIntakeDeps,
): OutboxConsumerBinding {
  return {
    consumerName: M21_SUPPLY_FULFILLMENT_INTAKE_CONSUMER,
    consumerModule: "m21",
    eventTypes: [M11_SUPPLY_FULFILLMENT_REQUESTED_EVENT],
    async handle(event): Promise<void> {
      await runSupplyFulfillmentIntake(deps, event.organizationId, event.payload);
    },
  };
}
