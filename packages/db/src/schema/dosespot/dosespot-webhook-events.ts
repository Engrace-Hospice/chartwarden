// @chartwarden/db — `dosespot_webhook_event` (M12 §3.3 / §7.4 D7). The encrypted-at-rest receipt for every
// signature-verified inbound DoseSpot webhook (script_status_update / refill_request / medication_history_result
// / patient_mismatch / prescriber_status_changed). The raw body is stored ONLY as a per-tenant DEK envelope
// (`raw_body_cipher` + wrapped `raw_body_dek`, M1 envelope-encryption) with a SHA-256 `body_digest` for later
// integrity verification; both cipher columns are additionally denylisted from the audit diff (§7.6 — the
// trigger records THAT a write happened, never the value) and the body is never logged (§7.4.7). Org-scoped
// (no patient column — payloads are decrypted and projected downstream, not stored in clear here). The
// (organization_id, dosespot_event_id) unique index gives webhook idempotency (re-delivery returns 200, no
// double-processing, §7.4.4). RLS + grants + the M4 write-audit trigger land in the RLS migration (M12-T02).
import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { dosespotWebhookEventType } from "../../enums";
import { organizations } from "../organizations";

export const dosespotWebhookEvents = pgTable(
  "dosespot_webhook_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),

    dosespotEventId: text("dosespot_event_id").notNull(), // idempotency
    eventType: dosespotWebhookEventType("event_type").notNull(),

    rawBodyCipher: text("raw_body_cipher").notNull(), // per-tenant DEK envelope (M1); denylisted (§7.6)
    rawBodyDek: text("raw_body_dek").notNull(), // wrapped DEK; denylisted (§7.6)
    bodyDigest: text("body_digest").notNull(), // sha256 of plaintext

    signatureVerifiedAt: timestamp("signature_verified_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    correlationId: text("correlation_id").notNull(),

    processedAt: timestamp("processed_at", { withTimezone: true }),
    processingOutcome: text("processing_outcome"),
    processingErrorClass: text("processing_error_class"),
  },
  (t) => ({
    dedupUnique: uniqueIndex("dswe_unique").on(t.organizationId, t.dosespotEventId),
  }),
);

export type DosespotWebhookEvent = typeof dosespotWebhookEvents.$inferSelect;
export type NewDosespotWebhookEvent = typeof dosespotWebhookEvents.$inferInsert;
