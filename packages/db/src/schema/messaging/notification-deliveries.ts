// @wardenx/db — `notification_delivery` (M36 Secure Messaging §3.6). One row per recipient ×
// channel for a dispatched alert, tracking the per-channel delivery lifecycle and vendor id.
// It is a pure child of `alert` (ON DELETE cascade) and inherits tenancy through that parent
// FK, so it carries NO organization_id and is opted out of the three-column rule via the
// check-tenancy NON_ORG_SCOPED allowlist (a reviewed change); RLS via the parent-join in
// M36-T03. M36-F06d: alert category + severity are DENORMALIZED from the parent at row
// creation (immutable) so the voice-SOS-only CHECK is a local-column comparison — PostgreSQL
// forbids a subquery in a CHECK.
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { alertCategory, alertSeverity, notificationChannel, notificationStatus } from "../../enums";
import { users } from "../users";
import { alerts } from "./alerts";
import { deliveryEndpoints } from "./delivery-endpoints";

export const notificationDeliveries = pgTable(
  "notification_delivery",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
    recipientUserId: uuid("recipient_user_id")
      .notNull()
      .references(() => users.id),
    alertCategory: alertCategory("alert_category").notNull(), // denormalized from parent alert
    alertSeverity: alertSeverity("alert_severity").notNull(), // denormalized from parent alert
    channel: notificationChannel("channel").notNull(),
    endpointId: uuid("endpoint_id").references(() => deliveryEndpoints.id),
    status: notificationStatus("status").notNull().default("pending"),
    vendorMessageId: text("vendor_message_id"), // Twilio SID / Postmark / push sub
    failReason: text("fail_reason"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
  },
  (t) => ({
    byAlert: index("notification_delivery_alert_idx").on(t.alertId),
    byRecipient: index("notification_delivery_recipient_idx").on(t.recipientUserId, t.queuedAt),
    byVendorMessage: index("notification_delivery_vendor_idx")
      .on(t.vendorMessageId)
      .where(sql`vendor_message_id IS NOT NULL`),
    // M36-F06d / ADR-0022 D1.2: local-column CHECK (no subquery) — voice only for a critical
    // field-safety alert.
    voiceSosOnly: check(
      "notification_delivery_voice_sos_only",
      sql`channel <> 'voice' OR (alert_category = 'field_safety' AND alert_severity = 'critical')`,
    ),
  }),
);

export type NotificationDelivery = typeof notificationDeliveries.$inferSelect;
export type NewNotificationDelivery = typeof notificationDeliveries.$inferInsert;
