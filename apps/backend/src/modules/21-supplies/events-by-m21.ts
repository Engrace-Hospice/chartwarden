// apps/backend/src/modules/21-supplies/events-by-m21.ts — Module 21's outbox-event contributions
// (spec §4.5.2). The `m21.*` taxonomy under the `m21.` namespace (M01 D8 / M03 D9 / M04 D9).
//
// check-fitness-gaps.ts scans this file for naming (`mN.<resource>.<verb>`), ownership (moduleOwner='m21')
// and valid declared consumers; the composition root merges it into the platform catalog at boot (the
// M15/M16/M23…M27/M30/M33/M34 events-by-mN precedent), and the dispatcher validates each `m21.*` publish
// against the TypeBox `payloadSchema` inside the SAME transaction as the mutation (transactional outbox).
//
// The shapes MIRROR the §4.5.2 payload interfaces frozen in `@chartwarden/types` (packages/types/src/
// supplies.ts, M21-T01) — those are the contract M11/M13/M22/M27/M30/M33/M36 type-check against; this file
// is their runtime validator. Every name is drawn from `M21_EVENT_NAMES` (the `satisfies` at the bottom
// proves the catalog covers the frozen list exactly), so a rename in the leaf breaks the build here rather
// than silently orphaning a subscriber.
//
// THREE NAMES ARE NORMALIZED against the spec's §4.5.2 table, and the reason is the gate: the spec writes
// `m21.controlled_substance_discrepancy`, `m21.vendor_confirmation_overdue` and `m21.delivery_overdue`,
// which are two-segment names the `mN.<resource>.<verb>` scan rejects. Architecture wins over a module
// spec, so the frozen leaf (and this catalog) use the three-segment forms. Same events, legal names.
//
// PHI POSTURE. No payload carries a name, an address, a diagnosis or a free-text clinical note: ids, enum
// tokens, decimal-string quantities and instants only. Two payloads are deliberately WIDE and both are
// controlled-substance accounting rather than clinical content — `comfort_kit.deployed_at_patient` ships
// the full per-line kit manifest because M13 must build its drawdown rows without reading back through a
// seam (§4.5.2), and `controlled_substance.discrepancy_detected` ships the whole custody chain because the
// DEA 21 CFR §1304 investigation question is "who touched it", not "how much is missing".
//
// QUANTITIES ARE DECIMAL STRINGS, never numbers. The columns are `numeric`; a 0.1 mL that round-trips
// through a JS float is not the quantity the perpetual log recorded. Money is integer CENTS for the same
// reason (a rounding drift on a cap-relevant accrual is a reportable finding).
import { Type } from "@sinclair/typebox";
import { HospiceCoverageSchema } from "@chartwarden/types";
import type { M21EventName, ModuleEventContribution } from "@chartwarden/types";

const Id = Type.String({ minLength: 1 });
const IdN = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);
const Iso = Type.String({ minLength: 1 });
const Str = Type.String();
const StrN = Type.Union([Type.String(), Type.Null()]);
const Bool = Type.Boolean();
/** A `numeric` column on the wire — see the header note on decimal strings. */
const Decimal = Type.String({ minLength: 1 });

/** The tenancy + clinical anchor every per-patient `m21.*` payload repeats (`M21PatientScopedEventBase`).
 *  `orgId` duplicates the envelope deliberately: M33's projector and M36's alert router both read the
 *  payload alone, and the §4.7 alert types are built from these fields without the envelope in hand. */
const patientScoped = {
  orgId: Id,
  patientId: Id,
  admissionId: Id,
  providerEntityId: Id,
  locationId: Id,
} as const;

/** One dispatched kit line (`ComfortKitDispatchedContentPayload`). `lotNumber` is NOT NULL on every
 *  controlled line at the schema level (§3.1 CHECK) but nullable here — the type is shared with the
 *  non-controlled lines, and the CHECK is the enforcement point. */
const dispatchedContent = Type.Object({
  dispatchedContentId: Id,
  comfortKitTemplateMedicationId: Id,
  medicationOrderId: IdN,
  rxnorm: Str,
  ndc: StrN,
  drugName: Str,
  strength: Str,
  dosageForm: Str,
  routeOfAdministration: Str,
  isControlledSubstance: Bool,
  controlledSubstanceSchedule: StrN,
  dispatchedQuantity: Decimal,
  dispatchedUnit: Str,
  lotNumber: StrN,
  expirationDate: StrN,
  manufacturerNdc: StrN,
  replenishmentThresholdPct: Type.Number(),
});

/** One reconciled kit line (`ComfortKitReturnedContentPayload`) — what went out, what came back, and what
 *  cannot be accounted for. `quantityUnaccounted` is the number a surveyor reads first. */
const returnedContent = Type.Object({
  returnedContentId: Id,
  dispatchedContentId: Id,
  comfortKitTemplateMedicationId: Id,
  medicationOrderId: IdN,
  rxnorm: Str,
  drugName: Str,
  isControlledSubstance: Bool,
  controlledSubstanceSchedule: StrN,
  lotNumber: StrN,
  dispatchedQuantity: Decimal,
  quantityReturned: Decimal,
  quantityDisposedAtHome: Decimal,
  quantityUnaccounted: Decimal,
  discrepancyPct: Type.Number(),
  discrepancyFlagged: Bool,
});

/** D7 — the courier attestation (`SupplyCourierAttestation`). Required on every kind: "who put the
 *  hospital bed in the room?" is asked long after the row goes terminal. */
const courierAttestation = Type.Object({
  deliveredByMembershipId: Id,
  deliveredAt: Iso,
  deliveryMethod: Str,
  evidenceDocumentId: IdN,
});

/** §2.7 / D5 — the par-stock threshold payload. NOT patient-scoped: par stock is agency inventory at a
 *  Location, with no patient in it at all. Shared by `below_threshold` and `stockout_imminent`. */
const parThreshold = Type.Object({
  orgId: Id,
  providerEntityId: Id,
  locationId: Id,
  parStockId: Id,
  supplyItemId: IdN,
  tenantSupplyItemExtensionId: IdN,
  supplyItemName: Str,
  currentQuantity: Decimal,
  reorderPoint: Decimal,
  minSafetyStock: Decimal,
  unit: Str,
  observedAt: Iso,
});

export const M21_OUTBOX_EVENTS: ModuleEventContribution = [
  // ── supply-request lifecycle (§2.2 / §4.5.2) ─────────────────────────────────────────────────────────
  {
    eventName: "m21.supply_request.status_changed",
    moduleOwner: "m21",
    description:
      "Every §2.2 supply-request transition. M11 auto-completes a one-shot order when `toStatus` reaches a terminal fulfillment state; M33 counts the transition. `fromStatus` is null on the intake insert (§7.1 acceptance 4) and `sourceOrderId` is null only for the replenish kind, which has no M11 order behind it.",
    payloadSchema: Type.Object({
      ...patientScoped,
      supplyRequestId: Id,
      kind: Str,
      sourceOrderId: IdN,
      fromStatus: StrN,
      toStatus: Str,
      occurredAt: Iso,
    }),
    declaredConsumers: ["m11"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m21.supply_request.created_from_external",
    moduleOwner: "m21",
    description:
      "A request created through the §4.8 `SupplyFulfillmentProvider` (a coordinator's direct entry) rather than the M11 cascade. §7.1 acceptance 3 is explicit that the M11 cascade must NOT emit this — the distinction is what keeps the §8.1 audit story truthful about who asked for the supply.",
    payloadSchema: Type.Object({
      ...patientScoped,
      supplyRequestId: Id,
      kind: Str,
      createdByMembershipId: Id,
      occurredAt: Iso,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m21.supply_request.delivered",
    moduleOwner: "m21",
    description:
      "The row reached `delivered` with its D7 courier attestation. The optional caregiver-signature capture is M21's own (F-191, #248) — synchronous, not an outbox consumer.",
    payloadSchema: Type.Object({
      ...patientScoped,
      supplyRequestId: Id,
      kind: Str,
      courierAttestation,
    }),
    // F-191 (#248) — m22 DROPPED from declaredConsumers, misdeclared: M22's own spec explicitly
    // disclaims owning signature capture (`CHARTWARDEN_MODULE_22_DOCUMENTS_SPEC_v0_5.md:126`, "M22 does
    // not capture signatures — the source module does"; line 2383 lists it as a non-goal even for
    // M39 consent, the nearest structural analog), and no capture route/seam/FormFill consumer
    // exists anywhere in `22-documents/` (confirmed by direct read, `render-consumer.ts:292-297`
    // already independently reached the same conclusion). Every signature flow in this codebase is
    // captured synchronously inside its OWNING module (M11/M12 orders, M7/M8/M15 attestations, M39
    // consent's `ConsentCaptureEvidence`) — never via an M22 outbox consumer. D7's "caregiver
    // signature is optional via M22's signature flow" describes a capability M22 was never going to
    // build; the real, still-unbuilt gap is a small M21-owned capture (mirroring M39's
    // `captureMethod`/`captureEvidence`/witness-evidence-document-reference shape), a scoped
    // proposal — not decided here — not an outbox binding.
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m21.supply_request.cancelled",
    moduleOwner: "m21",
    description:
      "The row reached `cancelled`. M11 releases the source order. `requiredVendorConfirmation` distinguishes the immediate pre-`ordered` cancellation from the two-phase one the vendor had to answer (§2.2).",
    payloadSchema: Type.Object({
      ...patientScoped,
      supplyRequestId: Id,
      sourceOrderId: IdN,
      reason: Str,
      cancelledAt: Iso,
      requiredVendorConfirmation: Bool,
    }),
    declaredConsumers: ["m11"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m21.supply_request.cancel_no_op",
    moduleOwner: "m21",
    description:
      "§7.7 — an `m11.order.supply_cancellation_requested` cascade reached an already-terminal request. Carries no tenancy block beyond `orgId` because nothing was mutated.",
    payloadSchema: Type.Object({
      orgId: Id,
      supplyRequestId: Id,
      sourceOrderId: Id,
      terminalStatus: Str,
      occurredAt: Iso,
    }),
    // F-166 (#248) — m11 REMOVED: checked against the code rather than the old description's "M11 would
    // hold the order open forever" fear. This event has exactly one producer
    // (`outbox-consumers/m11-order-cascade.ts`'s reply to M11's OWN `m11.order.supply_cancellation_
    // requested`), and by the time M21 emits it M11's order is ALREADY `discontinued` — the discharge
    // cascade (`11-orders/consumers/bindings.ts`, F-102) discontinues its order SYNCHRONOUSLY before it
    // ever asks M21. There is no second producer the way `.cancelled` has one (see the m11 group's F-166
    // paragraph), so a bound consumer here would always find a terminal order and always no-op — the
    // "hold the order open forever" scenario the old description named cannot occur given the real
    // cascade sequencing. Record-only — `seamConsumers: ["m33"]` matches every other record-only m21
    // event in this file (reporting reads the outbox stream regardless of whether a live consumer acts
    // on it).
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m21.supply_request.document_requested",
    moduleOwner: "m21",
    description:
      "The outbox-only handoff to M22 for a bill of lading, a packing list or the DEA-1304-format return receipt. M21 never renders a PDF and imports no M22 schema; M22 answers with `m22.document.rendered`.",
    payloadSchema: Type.Object({
      ...patientScoped,
      supplyRequestId: Id,
      dispatchId: IdN,
      documentKind: Str,
      requestedAt: Iso,
    }),
    declaredConsumers: ["m22"],
    isOutboxOnly: true,
  },
  {
    eventName: "m21.supply_request.vendor_confirmation_overdue",
    moduleOwner: "m21",
    description:
      "§2.10 — a request sat in `ordered` past the tenant's vendor-confirmation window (default 24h). ADVISORY: the row does not move. Auto-transitioning on lateness would erase the very evidence the supply team needs to chase the vendor.",
    payloadSchema: Type.Object({
      ...patientScoped,
      supplyRequestId: Id,
      orderedAt: Iso,
      windowHours: Type.Number(),
      detectedAt: Iso,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m21.supply_request.delivery_overdue",
    moduleOwner: "m21",
    description:
      "§2.10 — an `in_transit` request passed its own `data.deliveryWindowLatest`. Only fires when the request declared a window; also advisory.",
    payloadSchema: Type.Object({
      ...patientScoped,
      supplyRequestId: Id,
      deliveryWindowLatest: Iso,
      detectedAt: Iso,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m21.supply_request.invoice_accrued",
    moduleOwner: "m21",
    description:
      "D16 — the M27 cost-report forward seam. Amounts are integer CENTS (see the header). M27 consumes this once its accrual surface locks; until then the event is catalogued and emitted with no live subscriber, which is the correct posture for a forward seam.",
    payloadSchema: Type.Object({
      ...patientScoped,
      supplyRequestId: Id,
      vendorId: IdN,
      invoiceTotalCents: Type.Integer(),
      invoiceCurrency: Type.Literal("USD"),
      accruedAt: Iso,
    }),
    declaredConsumers: ["m27"],
    isOutboxOnly: true,
  },
  {
    eventName: "m21.supply_request.invoice_reconciled",
    moduleOwner: "m21",
    description:
      "D16 — the vendor invoice matched the accrual. `varianceCents` is SIGNED: positive means the vendor billed above what M21 accrued.",
    payloadSchema: Type.Object({
      ...patientScoped,
      supplyRequestId: Id,
      invoiceTotalCents: Type.Integer(),
      varianceCents: Type.Integer(),
      reconciledAt: Iso,
    }),
    declaredConsumers: ["m27"],
    isOutboxOnly: true,
  },

  // COP27 (42 CFR 418.24(c), workstream B) — a dme/supply request's hospice coverage determination changed.
  // M6 is the declared consumer (the election-statement addendum must be updated within 3 days of a
  // plan-of-care change that impacts its determinations, § 418.24(d)(2)); its binding lands with workstream
  // A, so the pair sits in scripts/outbox-deferred-consumers.ts until the COP27 integration.
  // PHI-POSTURE EXCEPTION (named, deliberate): `reason` is free text — the patient-facing clinical
  // explanation the addendum is REQUIRED to disclose to the patient, non-hospice providers and Medicare
  // contractors (§ 418.24(c)(6), (c)(9)), so carrying it to M6 is the point, not a leak.
  {
    eventName: "m21.supply_request.coverage_determination_changed",
    moduleOwner: "m21",
    description:
      "A dme/supply request's hospice coverage determination changed (covered_related | not_covered_unrelated | not_covered_other); M6 refreshes the election-statement addendum's non-covered list.",
    payloadSchema: Type.Object({
      orgId: Id,
      admissionId: Type.Optional(Id),
      patientId: Id,
      sourceId: Id,
      hospiceCoverage: HospiceCoverageSchema,
      previousHospiceCoverage: HospiceCoverageSchema,
      reason: Type.Union([Type.String({ maxLength: 2000 }), Type.Null()]),
      changedAt: Iso,
    }),
    declaredConsumers: ["m6"],
    isOutboxOnly: true,
  },

  // ── comfort-kit dispatch / deployment / return (§2.5 / §2.6 / §4.5.2) ────────────────────────────────
  {
    eventName: "m21.comfort_kit.dispatched",
    moduleOwner: "m21",
    description:
      "The `comfort_kit_dispatch` row exists and the kit left the hub. NOT yet at the patient — M13 must not open a deployment on this event (that is `deployed_at_patient`), or a kit lost in transit would show as bedside inventory.",
    payloadSchema: Type.Object({
      ...patientScoped,
      dispatchId: Id,
      supplyRequestId: Id,
      comfortKitTemplateId: Id,
      kitSerialNumber: Str,
      dispatchSource: Str,
      pharmacyDispatchMode: Str,
      pharmacyPartnerId: IdN,
      dispatchedByMembershipId: Id,
      dispatchedAt: Iso,
    }),
    declaredConsumers: [],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m21.comfort_kit.deployed_at_patient",
    moduleOwner: "m21",
    description:
      "§2.5 — the kit is physically at the patient. M13 creates its `comfort_kit_deployment` + per-medication drawdown rows FROM THIS PAYLOAD, which is why `contents` carries the full manifest: M13 must not have to read back through a seam to learn what is in the kit it is about to track.",
    payloadSchema: Type.Object({
      ...patientScoped,
      dispatchId: Id,
      supplyRequestId: Id,
      deploymentSite: Str,
      ipuRoomId: IdN,
      deployedAt: Iso,
      deployedByMembershipId: Id,
      contents: Type.Array(dispatchedContent),
      bolDocumentId: IdN,
    }),
    declaredConsumers: ["m13"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m21.comfort_kit.replenished",
    moduleOwner: "m21",
    description:
      "A `comfort_kit_replenish` request reached the patient. `contents` is a SUBSET of the original deployment — only the lines that crossed threshold — so M13 tops the existing deployment up rather than creating a second one for the same kit.",
    payloadSchema: Type.Object({
      ...patientScoped,
      dispatchId: Id,
      supplyRequestId: Id,
      sourceDeploymentId: Id,
      replenishedAt: Iso,
      contents: Type.Array(dispatchedContent),
    }),
    declaredConsumers: ["m13"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m21.comfort_kit.returned",
    moduleOwner: "m21",
    description:
      "The `comfort_kit_return` row reached `reconciled`; M13 flips its deployment's disposal status. The per-line accounting rides on the separate `return_reconciliation` event so a consumer that only needs the disposal fact does not have to parse the manifest.",
    payloadSchema: Type.Object({
      ...patientScoped,
      returnId: Id,
      dispatchId: Id,
      m13DeploymentId: Id,
      disposalMethod: Str,
      reconciledByMembershipId: Id,
      disposalWitnessMembershipId: IdN,
      reconciledAt: Iso,
    }),
    declaredConsumers: ["m13"],
    seamConsumers: ["m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m21.comfort_kit.return_reconciliation",
    moduleOwner: "m21",
    description:
      "§2.6 / D8 — the full per-line accounting. M13 closes its drawdowns; M30 files the survey record when `discrepancyDetected`. The flag is COMPUTED from the lines, never passed in: a discrepancy the reconciler can set is one they can clear.",
    payloadSchema: Type.Object({
      ...patientScoped,
      returnId: Id,
      dispatchId: Id,
      m13DeploymentId: Id,
      discrepancyDetected: Bool,
      perMedicationReconciliation: Type.Array(returnedContent),
      reconciledAt: Iso,
    }),
    // F-149 (#248) — m30 MOVED to seamConsumers, along with all four of its M21 siblings below: M21's
    // own spec (docs/modules/CHARTWARDEN_MODULE_21_SUPPLIES_DME_COMFORT_KITS_SPEC_v0_2.md:9,72) names the
    // real mechanism decisively — "30 (HQRP & Quality — … controlled-substance-discrepancy rate,
    // kit-return-on-time rate, par-stock-stockout rate; all read M21 via `SupplyFulfillmentProvider` and
    // `ComfortKitDispatchProvider`)" and "M21 publishes … seams; M30 consumes and computes" — never an
    // outbox push, matching M30's own blanket §1.1 principle that it never subscribes to an upstream
    // module's outbox (docs/modules/CHARTWARDEN_MODULE_30_HQRP_QUALITY_SPEC_v0_5.md:353). Both seams are
    // already registered at boot (`apps/backend/src/modules/21-supplies/seams/index.ts`); M30's side of
    // the call is what remains unbuilt — this event's own "M30 files the survey record" claim describes
    // a mechanism M30's spec never corroborates anywhere.
    declaredConsumers: ["m13"],
    seamConsumers: ["m30", "m33"],
    isOutboxOnly: true,
  },
  {
    eventName: "m21.comfort_kit.return_overdue",
    moduleOwner: "m21",
    description:
      "§2.6 — the daily scan crossed the 30-day compliance boundary (`overdue_30d`) or the 90-day assumption-of-loss (`unreturnable_90d`). The 90-day escalation ALSO fires `m21.controlled_substance.discrepancy_detected` when the kit held a scheduled line.",
    payloadSchema: Type.Object({
      ...patientScoped,
      returnId: Id,
      dispatchId: Id,
      returnRequiredAt: Iso,
      daysOverdue: Type.Integer({ minimum: 0 }),
      escalation: Str,
      containsControlledSubstance: Bool,
      detectedAt: Iso,
    }),
    // F-149 (#248) — m30 MOVED to seamConsumers: maps to M21's own named "kit-return-on-time rate" —
    // see `comfort_kit.return_reconciliation` above.
    declaredConsumers: [],
    seamConsumers: ["m30", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m21.controlled_substance.discrepancy_detected",
    moduleOwner: "m21",
    description:
      "D8 / DEA 21 CFR §1304 — a ≥5% shortfall on a scheduled line, an unreturnable kit that held one, or M13's bedside count re-emitted with M21 dispatch context (`detectionSource` says which). Always survey-investigable; carries the whole custody chain because the investigation question is who touched it.",
    payloadSchema: Type.Object({
      ...patientScoped,
      returnId: Id,
      dispatchId: Id,
      m13DeploymentId: IdN,
      detectionSource: Str,
      discrepantMedications: Type.Array(returnedContent),
      custodyChain: Type.Object({
        dispatchedByMembershipId: Id,
        retrievingMembershipId: IdN,
        disposalWitnessMembershipId: IdN,
        reconciledByMembershipId: IdN,
      }),
      detectedAt: Iso,
    }),
    // F-149 (#248) — m30 MOVED to seamConsumers: maps to M21's own named
    // "controlled-substance-discrepancy rate" — see `comfort_kit.return_reconciliation` above.
    declaredConsumers: [],
    seamConsumers: ["m30", "m33", "m36"],
    isOutboxOnly: true,
  },

  // ── par-stock monitoring (§2.7 / D5) ────────────────────────────────────────────────────────────────
  {
    eventName: "m21.par.below_threshold",
    moduleOwner: "m21",
    description:
      "§2.7 — the nightly per-Location par monitor found stock at or below the reorder point. The CRON emits; a mid-day dispatch decrement does not, so a busy Location raises one alert a night rather than one per kit.",
    payloadSchema: parThreshold,
    // F-149 (#248) — m30 MOVED to seamConsumers: maps to M21's own named "par-stock-stockout rate" —
    // see `comfort_kit.return_reconciliation` above.
    declaredConsumers: [],
    seamConsumers: ["m30", "m33", "m36"],
    isOutboxOnly: true,
  },
  {
    eventName: "m21.par.stockout_imminent",
    moduleOwner: "m21",
    description:
      "§2.7 — stock fell to or below `min_safety_stock`, the band under `below_threshold`. Distinct event rather than a severity field: a depleted hub cannot fill the next dispatch at all, and M36 routes it to a different recipient set.",
    payloadSchema: parThreshold,
    // F-149 (#248) — m30 MOVED to seamConsumers: same "par-stock-stockout rate" measure, the severity
    // band under `below_threshold` — see `comfort_kit.return_reconciliation` above.
    declaredConsumers: [],
    seamConsumers: ["m30", "m33", "m36"],
    isOutboxOnly: true,
  },
];

/** Compile-time proof the catalog covers the frozen §4.5.2 list EXACTLY — no event catalogued that the leaf
 *  does not name, and (via the length check below) none named that the catalog forgot. A missing entry
 *  would make the dispatcher reject the publish at runtime, in the middle of a transaction. */
const CATALOGUED: ReadonlySet<M21EventName> = new Set(
  M21_OUTBOX_EVENTS.map((e) => e.eventName as M21EventName),
);

/** Throws at import time if the catalog and the frozen name list ever diverge (M21-T04). */
export function assertM21EventCatalogComplete(names: readonly M21EventName[]): void {
  const missing = names.filter((n) => !CATALOGUED.has(n));
  if (missing.length > 0) {
    throw new Error(`events-by-m21: uncatalogued §4.5.2 event(s): ${missing.join(", ")}`);
  }
  if (CATALOGUED.size !== names.length) {
    throw new Error(
      `events-by-m21: catalog has ${CATALOGUED.size} entries for ${names.length} frozen names`,
    );
  }
}
