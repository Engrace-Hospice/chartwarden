// @wardenx/db — `user_notification_preferences` (M36 Secure Messaging §3.6). A user's per-org
// routing map (category → severity → channels), quiet hours, and bounded vacation forwarding.
// A NULL organization_id row is the user's cross-tenant default. The `vacation_shape` CHECK
// keeps the forward-target and the expiry paired and forward-looking. RLS + the M4 write-audit
// trigger land in M36-T03.
import { sql } from "drizzle-orm";
import { check, jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { users } from "../users";

export const userNotificationPreferences = pgTable(
  "user_notification_preferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "cascade",
    }), // null = cross-tenant default
    routingMap: jsonb("routing_map").notNull(), // {category: {severity: ['in_app','push',...]}}
    quietHours: jsonb("quiet_hours").notNull().default({
      tz: "America/Los_Angeles",
      ranges: [],
      severityOverride: "critical",
    }),
    vacationForwardToUserId: uuid("vacation_forward_to_user_id").references(() => users.id),
    vacationUntil: timestamp("vacation_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePerUserOrg: uniqueIndex("user_notification_preferences_unique").on(
      t.userId,
      t.organizationId,
    ),
    vacationShape: check(
      "user_notif_pref_vacation_shape",
      sql`(vacation_forward_to_user_id IS NOT NULL) = (vacation_until IS NOT NULL AND vacation_until > NOW())`,
    ),
  }),
);

export type UserNotificationPreferences = typeof userNotificationPreferences.$inferSelect;
export type NewUserNotificationPreferences = typeof userNotificationPreferences.$inferInsert;
