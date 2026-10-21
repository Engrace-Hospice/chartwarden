import { sql } from "drizzle-orm";
// @chartwarden/db — `stripe_webhook_event` (M35 §3.3). PLATFORM-ONLY (not tenant-scoped) — a single Stripe
// webhook may carry data spanning multiple tenants. `derived_organization_id` is a best-effort match
// (nullable) and is NOT the RLS org column (it has no `\borganization_id\b` word boundary, so the tenancy
// gate does not treat it as org-scoped — listed in NON_ORG_SCOPED). The `payload_ciphertext` is
// envelope-encrypted (D15); §3.6 denylists it + `payload_dek_ref` in the generated write-audit trigger
// (0143). The primary key is the Stripe event id (`evt_...`), a TEXT natural key.
import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const stripeWebhookEvent = pgTable(
  "stripe_webhook_event",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    apiVersion: text("api_version"),
    payloadCiphertext: text("payload_ciphertext").notNull(),
    payloadDekRef: text("payload_dek_ref").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    processingAttemptCount: integer("processing_attempt_count").notNull().default(0),
    signatureVerifiedAt: timestamp("signature_verified_at", { withTimezone: true }).notNull(),
    errorText: text("error_text"),
    derivedOrganizationId: text("derived_organization_id"),
  },
  (t) => ({
    eventTypeReceivedIx: index("stripe_webhook_event_type_received_ix").on(
      t.eventType,
      t.receivedAt,
    ),
    unprocessedIx: index("stripe_webhook_event_unprocessed_ix")
      .on(t.receivedAt)
      .where(sql`processed_at IS NULL`),
  }),
);

export type StripeWebhookEventRow = typeof stripeWebhookEvent.$inferSelect;
export type NewStripeWebhookEventRow = typeof stripeWebhookEvent.$inferInsert;
