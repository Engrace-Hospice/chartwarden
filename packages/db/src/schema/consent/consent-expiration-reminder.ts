// @chartwarden/db — `consent_expiration_reminder` (M39 Consent §3.3 #7). The fired-reminder log for the
// platform-floor 90/30/14/7/1-day cadence (D9): one row per (consent record, reminder kind), with an
// idempotency key so the hourly reminder cron never double-fires. delivery_channel routes through M36
// (alert / email / in-app). Org-scoped child of consent_record → standard app.org_id RLS in M39-T03.
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { consentReminderKind } from "../../enums";
import { organizations } from "../organizations";
import { consentRecord } from "./consent-record";

export const consentExpirationReminder = pgTable(
  "consent_expiration_reminder",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    consentRecordId: uuid("consent_record_id")
      .notNull()
      .references(() => consentRecord.id, { onDelete: "restrict" }),
    reminderKind: consentReminderKind("reminder_kind").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    firedAt: timestamp("fired_at", { withTimezone: true }),
    deliveryChannel: text("delivery_channel").notNull(), // 'm36_alert' | 'm36_email' | 'm36_inapp'
    recipientResolutionJsonb: jsonb("recipient_resolution_jsonb").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    m36AlertId: uuid("m36_alert_id"),
  },
  (t) => ({
    uniqIdem: uniqueIndex("uq_cer_idem").on(t.idempotencyKey),
    pendingIdx: index("ix_cer_pending").on(t.scheduledFor).where(sql`fired_at IS NULL`),
    consentIdx: index("ix_cer_consent").on(t.consentRecordId),
  }),
);

export type ConsentExpirationReminder = typeof consentExpirationReminder.$inferSelect;
export type NewConsentExpirationReminder = typeof consentExpirationReminder.$inferInsert;
