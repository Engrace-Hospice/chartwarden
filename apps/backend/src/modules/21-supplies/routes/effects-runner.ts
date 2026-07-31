// apps/backend/src/modules/21-supplies/routes/effects-runner.ts — M21-T05 (§2.11).
//
// The executor for the DECLARATIVE side-effect lists the §2.2–§2.7 machines return. M21-T03 deliberately
// made every transition hand back its effects as DATA (`{kind:'outbox', event}`, `{kind:'freeze_routing'}`,
// …) so the machines stay pure and unit-testable with no DB; this is the one place that turns them into
// writes, and it runs INSIDE the caller's transaction. That is what makes "the kit deployed but
// `deployed_at_patient` never went out" structurally impossible rather than merely reviewed-for (§2.11).
//
// FOUR rules the runner enforces so an effect cannot be quietly lost:
//
//   1. An `outbox` effect with NO payload supplied is a THROW, not a skip. A machine that declares an event
//      the service forgot to build a payload for is a bug, and swallowing it would ship a lifecycle whose
//      consumers silently never hear about one transition — M13 would never learn a kit reached the
//      bedside, and M11 would hold an order open forever.
//   2. An UNKNOWN `set_timestamp.field` is a THROW. This is the M21-T03 lesson written into code: a pure
//      machine's `set_timestamp` effect type-checks against nothing, so an effect naming a column the
//      schema does not have compiles clean and passes all fourteen gates while writing nothing. The map
//      below is closed, the `satisfies` at its foot pins it to real Drizzle column keys, and a field the
//      map does not know raises {@link UnknownTimestampFieldError} rather than being skipped.
//   3. `audit` is a no-op HERE and that is correct: the M4 write-audit triggers (migration 0106) record
//      every mutation with the per-table D13 denylist, so a hand-written audit row would be a second,
//      divergent account of the same write.
//   4. `alert` is BEST-EFFORT and outside the failure path. M36 owns delivery, retry and DLQ; a comfort-kit
//      dispatch must not roll back because a notification channel is down. Everything else — the row
//      writes and the outbox — is inside the transaction and fails it.
//
// Effects the runner deliberately does NOT execute are listed at {@link UNHANDLED_EFFECT_KINDS} with the
// reason, so "it silently did nothing" is never the explanation for a missing write.
import type { M21EventName } from "@wardenx/types";
import type { SupplySideEffect } from "../lifecycle/index";
import type { AlertPort, OutboxEmission, WriteOutboxPort } from "./write-service";

/** The column patch a transition's mechanical effects accumulate, applied by the caller in one UPDATE. */
export interface EffectPatch {
  // supply_request
  orderedAt?: Date;
  shippedAt?: Date;
  deliveredAt?: Date;
  receivedConfirmedAt?: Date;
  completedAt?: Date;
  cancelledAt?: Date;
  cancellationPendingAt?: Date;
  cancellationReason?: string;
  routingRuleResolvedJsonb?: unknown;
  assignedVendorId?: string | null;
  vendorOrderReference?: string;
  trackingNumber?: string;
  carrier?: string;
  deliveredByMembershipId?: string;
  deliveryMethod?: string;
  deliveryEvidenceDocumentId?: string | null;
  receivedConfirmedActor?: string;
  // comfort_kit_dispatch
  deployedAtPatientAt?: Date;
  deployedByMembershipId?: string;
  dispatchStatus?: string;
  m13DeploymentId?: string;
  m13DeploymentLinkResolvedAt?: Date;
  // comfort_kit_return
  retrievingAt?: Date;
  retrievedAt?: Date;
  returnedToHubAt?: Date;
  reconciledAt?: Date;
  assignedRetrievingMembershipId?: string;
  disposalMethod?: string;
  disposalWitnessMembershipId?: string | null;
  disposalMethodJurisdictionPolicyDigest?: string;
  unreturnableReason?: string;
  unreturnableAttestedByMembershipId?: string;
  // comfort_kit_template / par_stock
  effectiveTo?: Date;
  lastParReviewAt?: Date;
  currentQuantity?: string;
}

/**
 * `set_timestamp.field` (a §3.1 column name) → the patch key it writes. CLOSED (rule 2): every field any
 * §2.2–§2.7 machine emits appears here, and anything else throws. The `satisfies` pins the VALUES to
 * {@link EffectPatch} keys, so renaming a patch field breaks this map at compile time — which is the half
 * of the M21-T03 gotcha a runtime check cannot catch.
 */
const TIMESTAMP_FIELDS = {
  ordered_at: "orderedAt",
  shipped_at: "shippedAt",
  delivered_at: "deliveredAt",
  received_confirmed_at: "receivedConfirmedAt",
  completed_at: "completedAt",
  cancelled_at: "cancelledAt",
  cancellation_pending_at: "cancellationPendingAt",
  deployed_at_patient_at: "deployedAtPatientAt",
  retrieving_at: "retrievingAt",
  retrieved_at: "retrievedAt",
  returned_to_hub_at: "returnedToHubAt",
  reconciled_at: "reconciledAt",
  effective_to: "effectiveTo",
  last_par_review_at: "lastParReviewAt",
} as const satisfies Readonly<Record<string, keyof EffectPatch>>;

/** Rule 2 — a machine named a column the runner (and therefore the schema) does not know. */
export class UnknownTimestampFieldError extends Error {
  readonly code = "M21_UNKNOWN_TIMESTAMP_EFFECT";
  constructor(field: string) {
    super(
      `m21: a transition declared set_timestamp on '${field}', which is not an M21 column the effects runner writes`,
    );
    this.name = "UnknownTimestampFieldError";
  }
}

/**
 * The effect kinds the runner does not execute, and why. Each is handled by the calling service because it
 * needs reads or child-row writes the runner has no business doing:
 *
 *   • `create_dispatch` / `insert_returned_contents` — insert CHILD rows whose columns (lot numbers,
 *     per-line quantities) the effect descriptor deliberately does not carry: putting a controlled
 *     substance's lot number in a machine's return value would put it in every unit-test snapshot.
 *   • `create_return` — needs the originating dispatch's manifest to pre-populate expected quantities.
 *   • `adjust_par_stock` — the caller holds the `par_stock` row it is decrementing and applies the delta
 *     with its own optimistic-concurrency guard; a blind UPDATE here could drive a shelf negative.
 *   • `request_document` — the M22 handoff carries the §4.5.2 `document_requested` payload, which the
 *     caller assembles (it needs the patient/admission anchor the effect does not repeat).
 *   • `link_m13_deployment` — arrives on the §4.5.1 inbound path, not a route transition.
 */
export const UNHANDLED_EFFECT_KINDS = [
  "create_dispatch",
  "insert_returned_contents",
  "create_return",
  "adjust_par_stock",
  "request_document",
  "link_m13_deployment",
] as const satisfies readonly SupplySideEffect["kind"][];

const UNHANDLED = new Set<string>(UNHANDLED_EFFECT_KINDS);

/** What the runner needs to turn declared effects into writes. */
export interface EffectContext {
  readonly organizationId: string;
  readonly at: Date;
  readonly outbox: WriteOutboxPort;
  readonly alerts?: AlertPort;
  /** Aggregate identity for the outbox envelope (`supply_request` + the request id, unless overridden). */
  readonly aggregateKind: string;
  readonly aggregateId: string;
  /** One payload per `outbox` effect the transition declared. A missing entry throws (rule 1). */
  readonly payloads: Partial<Record<M21EventName, Record<string, unknown>>>;
  /** One payload per `alert` effect. A missing entry SKIPS — an alert is advisory, an event is a contract. */
  readonly alertPayloads?: Partial<Record<string, Record<string, unknown>>>;
}

/** A programming error: a machine declared an event the service built no payload for. */
export class MissingOutboxPayloadError extends Error {
  readonly code = "M21_MISSING_OUTBOX_PAYLOAD";
  constructor(eventName: string) {
    super(`m21: no outbox payload was supplied for the declared event '${eventName}'`);
    this.name = "MissingOutboxPayloadError";
  }
}

/**
 * Execute the mechanical half of a transition's effect list inside the caller's transaction, returning the
 * accumulated column patch the caller applies with its own optimistic-concurrency UPDATE.
 */
export async function runEffects(
  tx: unknown,
  effects: readonly SupplySideEffect[],
  ctx: EffectContext,
): Promise<EffectPatch> {
  const patch: EffectPatch = {};
  const set = (key: keyof EffectPatch, value: unknown): void => {
    (patch as Record<string, unknown>)[key] = value;
  };

  for (const effect of effects) {
    switch (effect.kind) {
      case "audit":
        break; // rule 3 — the M4 trigger owns the audit row
      case "outbox": {
        const payload = ctx.payloads[effect.event];
        if (payload === undefined) throw new MissingOutboxPayloadError(effect.event);
        const emission: OutboxEmission = {
          eventName: effect.event,
          payload,
          organizationId: ctx.organizationId,
          aggregateKind: ctx.aggregateKind,
          aggregateId: ctx.aggregateId,
        };
        await ctx.outbox.publish(tx, emission);
        break;
      }
      case "alert": {
        const payload = ctx.alertPayloads?.[effect.alert];
        if (payload === undefined || ctx.alerts === undefined) break;
        // rule 4 — best effort, outside the failure path.
        await ctx.alerts
          .emit({ organizationId: ctx.organizationId, kind: effect.alert, payload })
          .catch(() => undefined);
        break;
      }
      case "set_timestamp": {
        const key = (TIMESTAMP_FIELDS as Record<string, keyof EffectPatch | undefined>)[
          effect.field
        ];
        if (key === undefined) throw new UnknownTimestampFieldError(effect.field); // rule 2
        set(key, new Date(effect.at));
        break;
      }
      case "freeze_routing": {
        // D4 — written ONCE, at `vendor_assigned`. `assignedVendorId` moves with it so the frozen record
        // and the queryable column can never disagree about which vendor got the order.
        set("routingRuleResolvedJsonb", effect.resolved);
        set("assignedVendorId", effect.resolved.assignedVendorId);
        break;
      }
      case "record_vendor_order":
        set("vendorOrderReference", effect.vendorOrderReference);
        break;
      case "record_shipment":
        set("trackingNumber", effect.trackingNumber);
        set("carrier", effect.carrier);
        break;
      case "record_courier_attestation":
        set("deliveredByMembershipId", effect.attestation.deliveredByMembershipId);
        set("deliveredAt", new Date(effect.attestation.deliveredAt));
        set("deliveryMethod", effect.attestation.deliveryMethod);
        set("deliveryEvidenceDocumentId", effect.attestation.evidenceDocumentId);
        break;
      case "record_received_confirmation":
        set("receivedConfirmedActor", effect.actor);
        set("receivedConfirmedAt", new Date(effect.at));
        break;
      case "record_cancellation":
        set("cancellationReason", effect.reason);
        // `requiredVendorConfirmation` is NOT a column — it rides the §4.5.2 `cancelled` payload, where
        // M11 reads it to tell an immediate cancellation from one the vendor had to answer.
        set(effect.requiredVendorConfirmation ? "cancellationPendingAt" : "cancelledAt", new Date(effect.at));
        break;
      case "set_dispatch_status":
        set("dispatchStatus", effect.status);
        break;
      case "assign_retriever":
        set("assignedRetrievingMembershipId", effect.membershipId);
        break;
      case "record_unreturnable":
        set("unreturnableReason", effect.reason);
        set("unreturnableAttestedByMembershipId", effect.attestedByMembershipId);
        break;
      case "record_disposal":
        set("disposalMethod", effect.disposalMethod);
        set("disposalWitnessMembershipId", effect.witnessMembershipId);
        set("disposalMethodJurisdictionPolicyDigest", effect.jurisdictionPolicyDigest);
        break;
      default:
        if (!UNHANDLED.has(effect.kind)) {
          // A NEW effect kind nobody taught the runner about. Same argument as rule 2: silence here is a
          // write that never happened, discovered in production.
          throw new UnknownTimestampFieldError(effect.kind);
        }
        break;
    }
  }

  return patch;
}
