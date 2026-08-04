// @wardenx/db — `supply_request` (M21 §3.1.7). D1's SHARED row: one table spanning all four kinds
// (`dme` | `supply` | `comfort_kit_deploy` | `comfort_kit_replenish`), discriminated by `kind` with the
// per-kind payload in the TypeBox-validated `data` jsonb. Four near-identical tables would have meant four
// copies of the §2.2 lifecycle, four cancellation cascades and four places for M11 to look.
//
// D12 / §3.6: PARTITIONED, monthly RANGE by `created_at`, composite PRIMARY KEY (id, created_at) declared in
// migration 0104 (Drizzle cannot express a partitioned table, so the `.primaryKey()` below is the ORM's view
// of row identity only). It is in its OWN migration file because check-ddl-legality derives one partition
// column per FILE — `comfort_kit_dispatch` partitions by `dispatched_at` and lands in 0105.
//
// TENANCY (ARCH-011 / ADR-0010): organization_id, patient_id, admission_id, location_id and
// provider_entity_id are ALL NOT NULL — §3.0 is explicit that a request is admission-anchored and
// dispatch-Location-anchored. RLS pivots on organization_id alone; the courier's own-delivery narrowing and
// the billing clerk's invoice-only projection are M3 ABAC at the route, never a second policy.
//
// §3.0 / M21-F04 FOLDS (the §3.2 columns §4/§7 actually use):
//   • invoice — `invoice_total_cents` / `invoice_currency` / `invoice_accrued_at` /
//     `invoice_reconciled_at` / `invoice_variance_cents`, backing D16's `m21.supply_request.invoice_accrued`
//     + `invoice_reconciled` events and `SupplyCostProvider`. Integer CENTS, not the draft's `text` dollars:
//     `M21SupplyRequestInvoiceAccruedPayload` (locked in M21-T01) publishes `invoiceTotalCents`, and a
//     rounding drift on a cap-relevant accrual is a reportable finding.
//   • delivery evidence — `delivery_evidence_document_id`, the M22 signature/photo artifact that
//     `SupplyCourierAttestation.evidenceDocumentId` publishes. The draft's `courier_attestation_jsonb` +
//     `caregiver_signature_request_id` are NOT folded: §3.1 already stores the attestation as the three
//     discrete columns the seam type names (`delivered_by_membership_id` / `delivered_at` /
//     `delivery_method`), and a jsonb copy of columns that already exist is a second source of truth.
//   • `requested_by_membership_id` — the coordinator behind a §4.8 `createDirectSupplyRequest`.
//
// CROSS-MODULE FK POLICY: only organization_id / provider_entity_id / location_id (M1 core) carry real FKs.
// patient_id (M5), admission_id (M6), source_order_id (M11), source_replenishment_event_id (M1 outbox),
// assigned_vendor_id + pharmacy_partner_id (M40), document_id (M22) and every `*_membership_id` (M2) are
// LOGICAL uuid, validated at the write boundary.
import { sql } from "drizzle-orm";
import { bigint, check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { supplyDeliveryMethod, supplyRequestKind, supplyRequestStatus } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const supplyRequest = pgTable(
  "supply_request",
  {
    id: uuid("id").primaryKey().defaultRandom(), // composite PK (id, created_at) declared in SQL (0104)
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // logical FK → M5
    admissionId: uuid("admission_id").notNull(), // logical FK → M6
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),

    // Provenance — exactly one upstream, or neither for a §4.8 direct coordinator entry (see the CHECK).
    sourceOrderId: uuid("source_order_id"), // logical FK → M11 order
    sourceReplenishmentEventId: uuid("source_replenishment_event_id"), // M1 outbox event id
    requestedByMembershipId: uuid("requested_by_membership_id"), // logical FK → M2

    kind: supplyRequestKind("kind").notNull(),
    /** Per-kind payload, validated against the matching TypeBox in `@wardenx/supplies` before the write. */
    data: jsonb("data").notNull(),
    status: supplyRequestStatus("status").notNull().default("requested"),

    // D4 routing, frozen at the `vendor_assigned` transition.
    assignedVendorId: uuid("assigned_vendor_id"), // logical FK → M40 DmeVendor; NULL for the internal hub
    routingRuleResolvedJsonb: jsonb("routing_rule_resolved_jsonb"),
    pharmacyPartnerId: uuid("pharmacy_partner_id"), // logical FK → M40 Pharmacy; kit kinds only

    documentId: uuid("document_id"), // logical FK → M22 BOL / packing list

    vendorOrderReference: text("vendor_order_reference"), // vendor PO, set at `ordered`
    trackingNumber: text("tracking_number"),
    carrier: text("carrier"),

    orderedAt: timestamp("ordered_at", { withTimezone: true }),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),

    // D7 delivery confirmation — the three columns `SupplyCourierAttestation` publishes, plus the optional
    // M22 evidence artifact.
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    deliveredByMembershipId: uuid("delivered_by_membership_id"), // logical FK → M2
    deliveryMethod: supplyDeliveryMethod("delivery_method"),
    deliveryEvidenceDocumentId: uuid("delivery_evidence_document_id"), // logical FK → M22

    receivedConfirmedAt: timestamp("received_confirmed_at", { withTimezone: true }),
    /** `SupplyReceivedConfirmedActor` — who said it arrived (CHECK-constrained below). */
    receivedConfirmedActor: text("received_confirmed_actor"),

    completedAt: timestamp("completed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    /** D2 — the row entered `cancellation_pending`; the vendor has not answered yet. NOT terminal. */
    cancellationPendingAt: timestamp("cancellation_pending_at", { withTimezone: true }),
    /** Free-text — D13 audit-denylisted. */
    cancellationReason: text("cancellation_reason"),
    cancellationVendorResponseJsonb: jsonb("cancellation_vendor_response_jsonb"),

    /** Free-text ("leave with the daughter at the blue house") — D13 audit-denylisted. */
    deliveryInstructions: text("delivery_instructions"),

    // D16 invoice accrual / reconciliation (§3.0 fold). Integer cents; `bigint` in `mode: "number"` because
    // a supply invoice never approaches 2^53 cents and the seam publishes a JS number.
    invoiceTotalCents: bigint("invoice_total_cents", { mode: "number" }),
    invoiceCurrency: text("invoice_currency").notNull().default("USD"),
    invoiceAccruedAt: timestamp("invoice_accrued_at", { withTimezone: true }),
    invoiceReconciledAt: timestamp("invoice_reconciled_at", { withTimezone: true }),
    /** Signed: positive means the vendor billed above the accrual. */
    invoiceVarianceCents: bigint("invoice_variance_cents", { mode: "number" }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), // PARTITION KEY
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgStatusIdx: index("supply_request_org_status_idx").on(
      t.organizationId,
      t.status,
      t.createdAt,
    ),
    patientIdx: index("supply_request_patient_idx").on(t.organizationId, t.patientId, t.createdAt),
    admissionIdx: index("supply_request_admission_idx").on(
      t.organizationId,
      t.admissionId,
      t.createdAt,
    ),
    sourceOrderIdx: index("supply_request_source_order_idx")
      .on(t.sourceOrderId)
      .where(sql`source_order_id IS NOT NULL`),
    sourceReplenishIdx: index("supply_request_source_replenish_idx")
      .on(t.sourceReplenishmentEventId)
      .where(sql`source_replenishment_event_id IS NOT NULL`),
    vendorIdx: index("supply_request_vendor_idx")
      .on(t.assignedVendorId, t.status)
      .where(sql`assigned_vendor_id IS NOT NULL`),
    inFlightIdx: index("supply_request_in_flight_idx")
      .on(t.organizationId, t.locationId, t.createdAt)
      .where(sql`status IN ('requested','vendor_assigned','ordered','in_transit','delivered')`),

    // DEVIATION FROM §3.1.7 (documented, narrow): the spec's provenance CHECK additionally requires
    // `source_order_id IS NOT NULL` on every non-replenish kind, which makes §4.8's
    // `createDirectSupplyRequest` — the coordinator's direct entry, whose published input types
    // `sourceOrderId` as `OrderRecordId | null` — impossible to write. The replenish branch is kept
    // VERBATIM (a replenish must carry its outbox event and must never carry an order); the non-replenish
    // branch is loosened only to "must not carry a replenishment event", and the second CHECK below makes
    // an unattributed request impossible: no order, no replenishment event ⇒ a named human requester.
    provenanceMatchesKind: check(
      "m21_supply_request_provenance",
      sql`(kind = 'comfort_kit_replenish'
             AND source_replenishment_event_id IS NOT NULL
             AND source_order_id IS NULL)
          OR (kind <> 'comfort_kit_replenish' AND source_replenishment_event_id IS NULL)`,
    ),
    directEntryIsAttributed: check(
      "m21_supply_request_attributed",
      sql`source_order_id IS NOT NULL
          OR source_replenishment_event_id IS NOT NULL
          OR requested_by_membership_id IS NOT NULL`,
    ),
    // §3.1.7 — a request cannot leave `requested` without the routing resolution frozen onto it. This is
    // the survey-reconstruction guarantee: every dispatched row can answer "why this vendor".
    routedBeyondRequested: check(
      "m21_supply_request_routing_frozen",
      sql`status NOT IN ('vendor_assigned','ordered','in_transit','delivered','received_confirmed','completed','returned')
          OR routing_rule_resolved_jsonb IS NOT NULL`,
    ),
    receivedActorIsKnown: check(
      "m21_supply_request_received_actor",
      sql`received_confirmed_actor IS NULL
          OR received_confirmed_actor IN ('caregiver','patient','supply_team','system_auto_confirm')`,
    ),
  }),
);

export type SupplyRequestRow = typeof supplyRequest.$inferSelect;
export type NewSupplyRequestRow = typeof supplyRequest.$inferInsert;
