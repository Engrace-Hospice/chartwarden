// @chartwarden/db — `medication_order_transmission` (M12 §3.3). The "audit anchor" for every DoseSpot adapter
// call: one row per NewRx transmission attempt, carrying the D8 idempotency key (sha256 of
// prescriberMembershipId + patientId + rxBusinessKey + medicationOrderId) and the rx-business-key (sha256 of rxcui + strength +
// canonicalized sig), the queue→start→succeeded/failed timestamps, the retry counter, and the PHI-scrubbed
// last-error fields (`last_error_detail` denylisted from the audit diff, §7.6 — pharmacy NACK text may carry
// PHI fragments). Org-scoped operational table (no patient column → no three-column rule); `medication_order_id`
// is a plain uuid with NO single-column SQL FK (medication_order is partitioned). RLS + grants + the M4
// write-audit trigger land in the RLS migration (M12-T02).
import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const medicationOrderTransmissions = pgTable(
  "medication_order_transmission",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    medicationOrderId: uuid("medication_order_id").notNull(), // M12 partitioned parent → no single-col FK

    idempotencyKey: text("idempotency_key").notNull(), // D8: sha256(prescriberMembershipId, patientId, rxBusinessKey, medicationOrderId)
    rxBusinessKey: text("rx_business_key").notNull(), // D8: sha256(rxcui, strength, sig_canonical)

    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    transmissionStartedAt: timestamp("transmission_started_at", { withTimezone: true }),
    // Migration 1386: the nonce the fence writes with the stamp. The worker owns its vendor call only while this is still its own; cleared with the stamp.
    callToken: uuid("call_token"),
    transmissionSucceededAt: timestamp("transmission_succeeded_at", { withTimezone: true }),
    transmissionFailedAt: timestamp("transmission_failed_at", { withTimezone: true }),

    dosespotPrescriptionId: text("dosespot_prescription_id"),
    dosespotResponseDigest: text("dosespot_response_digest"),

    retryCount: integer("retry_count").notNull().default(0),
    lastErrorClass: text("last_error_class"),
    lastErrorDetail: text("last_error_detail"), // PHI-scrubbed; denylisted (§7.6)
    correlationId: text("correlation_id").notNull(),
  },
  (t) => ({
    byIdempotencyUnique: uniqueIndex("mot_idempotency_unique").on(
      t.organizationId,
      t.idempotencyKey,
    ),
    byInFlight: index("mot_in_flight_idx")
      .on(t.organizationId, t.transmissionSucceededAt, t.transmissionFailedAt)
      .where(sql`transmission_succeeded_at IS NULL AND transmission_failed_at IS NULL`),
    // Migration 1385: the age alert's EXISTS probe (is there a transmission row for this order queued before
    // the cutoff) and the by-order lookup of the settle/retry paths. No FK covers medication_order_id.
    byOrder: index("mot_order_idx").on(t.organizationId, t.medicationOrderId, t.queuedAt),
  }),
);

export type MedicationOrderTransmission = typeof medicationOrderTransmissions.$inferSelect;
export type NewMedicationOrderTransmission = typeof medicationOrderTransmissions.$inferInsert;
