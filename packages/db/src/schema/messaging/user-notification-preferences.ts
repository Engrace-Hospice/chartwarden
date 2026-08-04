// @wardenx/db — `user_notification_preferences` (M36 Secure Messaging §3.6). A user's per-org
// routing map (category → severity → channels), quiet hours, and bounded vacation forwarding.
// A NULL organization_id row is the user's cross-tenant default. RLS + the M4 write-audit trigger
// land in M36-T03.
//
// NO `vacation_shape` CHECK (DB-005, dropped in migration 0162): a `vacation_until > NOW()` CHECK
// re-validates on every future write to the row using the CURRENT time, not the time the value was
// set — so a legitimately-future expiry at write time fails every subsequent update (even to an
// unrelated column) once it naturally elapses, and breaks `pg_restore`'s COPY-time re-validation on
// any row restored after its vacation window has passed. The pairing (forward target ⇒ future
// expiry) is enforced at write time instead — see `putPreferences` in
// `apps/backend/src/modules/36-messaging/messaging-route-service-db.ts`.
import { jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
  }),
);

export type UserNotificationPreferences = typeof userNotificationPreferences.$inferSelect;
export type NewUserNotificationPreferences = typeof userNotificationPreferences.$inferInsert;
