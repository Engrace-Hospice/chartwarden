// @chartwarden/db — `portal_notification_preference` (M31 §3.3; migration 0422, GAP-092). One row per (portal account,
// channel): the caregiver's per-channel opt-in plus quiet hours. A channel with no row reads as its default.
// ORG-SCOPED (organization_id NOT NULL, RLS on app.org_id); no PHI (a channel flag and two clock hours).
import {
  boolean,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { portalAccounts } from "./portal-accounts";

export const portalNotificationPreferences = pgTable(
  "portal_notification_preference",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    portalAccountId: uuid("portal_account_id")
      .notNull()
      .references(() => portalAccounts.id, { onDelete: "restrict" }),
    /** email | sms | push (CHECK-constrained in the migration). */
    channel: text("channel").notNull(),
    enabled: boolean("enabled").notNull(),
    quietHoursStartHour: smallint("quiet_hours_start_hour"),
    quietHoursEndHour: smallint("quiet_hours_end_hour"),
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    accountChannelUnique: uniqueIndex("portal_notification_preference_account_channel_uq").on(
      t.portalAccountId,
      t.channel,
    ),
    orgIdx: index("portal_notification_preference_org_idx").on(t.organizationId),
  }),
);

export type PortalNotificationPreferenceRow = typeof portalNotificationPreferences.$inferSelect;
export type NewPortalNotificationPreferenceRow = typeof portalNotificationPreferences.$inferInsert;
