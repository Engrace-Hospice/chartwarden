import { index, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../users";
import { alerts } from "./alerts";

/**
 * Per-user interaction state for an M36 alert.
 *
 * DISTINCT from notification_delivery:
 * - notification_delivery = transport lifecycle, one row per recipient × channel
 * - alert_receipt = user-facing inbox state, one row per alert × recipient
 *
 * This is a pure child of alert and inherits organization tenancy through the
 * parent alert, mirroring notification_delivery.
 */
export const alertReceipts = pgTable(
  "alert_receipt",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    alertId: uuid("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),

    recipientUserId: uuid("recipient_user_id")
      .notNull()
      .references(() => users.id),

    readAt: timestamp("read_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqueAlertRecipient: uniqueIndex("alert_receipt_alert_recipient_unique").on(
      t.alertId,
      t.recipientUserId,
    ),

    byRecipient: index("alert_receipt_recipient_idx").on(t.recipientUserId, t.createdAt),

    byAlert: index("alert_receipt_alert_idx").on(t.alertId),
  }),
);

export type AlertReceipt = typeof alertReceipts.$inferSelect;
export type NewAlertReceipt = typeof alertReceipts.$inferInsert;
