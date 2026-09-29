// @wardenx/db — `order_transmission_attestation` (F-188, #248; migration 0266). One APPEND-ONLY row per operator
// ATTESTED recovery of a lab order that failed after a message was built (`POST /api/v1/orders/:id/recover-transmission`):
// what was attested, the STRUCTURED evidence (who at the lab was contacted + the lab's own reference), what the order's
// failure reason was at the time, what the system then did, the attempt it started (NULL for `received_by_lab`) and
// who attested. The evidence columns are CHECK-constrained to shapes that cannot carry a patient identifier (a name has
// no digits; a reference has no spaces). `order_record_id` is a plain uuid with NO SQL FK (order_record is partitioned;
// the `order_discontinuation` precedent). Grants are SELECT + INSERT only and a trigger rejects UPDATE/DELETE. RLS +
// FORCE + the M4 write-audit trigger (the contact NAME denylisted) land in the migration.
import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const orderTransmissionAttestations = pgTable(
  "order_transmission_attestation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // Denormalized siting copied from the order (both nullable on order_record since mig 0131).
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    orderRecordId: uuid("order_record_id").notNull(), // order_record is partitioned → no single-col SQL FK
    /** `not_received_by_lab` | `received_by_lab` (CHECK-constrained). */
    attestation: text("attestation").notNull(),
    /** `redispatched` | `marked_transmitted` (CHECK-constrained; agrees with `attestation` and `attempt_id`). */
    outcome: text("outcome").notNull(),
    /** Who at the lab was contacted — letters/space/`.'-` only (no digits); denylisted in the audit diff. */
    labContactName: text("lab_contact_name").notNull(),
    /** The lab's own reference for the call/confirmation — `[A-Za-z0-9._#/-]` only (no spaces). */
    labReference: text("lab_reference").notNull(),
    /** The order's `transmission_failure_reason` when it was attested (`dlq_exhausted`, `application_reject`, …). */
    priorFailureReason: text("prior_failure_reason").notNull(),
    /** The outbound attempt this attestation started; NULL for `received_by_lab` (nothing was sent). */
    attemptId: uuid("attempt_id"),
    /** Logical M1 ref (no FK): who attested, as the acting membership. */
    attestedByMembershipId: uuid("attested_by_membership_id"),
    /** The Better Auth USER id the write-audit trigger also records as the actor. */
    attestedByUserId: uuid("attested_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrder: index("order_transmission_attestation_order_idx").on(
      t.organizationId,
      t.orderRecordId,
      t.createdAt,
    ),
  }),
);

export type OrderTransmissionAttestation = typeof orderTransmissionAttestations.$inferSelect;
export type NewOrderTransmissionAttestation = typeof orderTransmissionAttestations.$inferInsert;
