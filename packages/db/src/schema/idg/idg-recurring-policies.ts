// @chartwarden/db — `idg_recurring_policy` (M14 §3.3.1). Per-location IDG cadence config: the §2.2 recurring
// meeting template (cadence/anchor/start-time/duration), the §2.3 post-discharge wrap-up window, and the
// default coordinator. Org+location-scoped (NOT patient-bearing → no three-column PHI rule). Actor refs
// (default_coordinator_membership_id → M1 membership) are plain uuid app-validated, NOT cross-module FKs;
// only the tenancy spine (organization / location) carries FKs. RLS + grants + the M4 write-audit trigger
// land in the RLS migration (M14-T02).
import { boolean, integer, pgTable, text, time, timestamp, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";

export const idgRecurringPolicy = pgTable("idg_recurring_policy", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  locationId: uuid("location_id")
    .notNull()
    .references(() => locations.id, { onDelete: "restrict" }),
  cadenceDays: integer("cadence_days").notNull().default(14),
  dayOfWeekAnchor: text("day_of_week_anchor").notNull(),
  startTimeLocal: time("start_time_local").notNull().default("09:00"),
  durationMinutes: integer("duration_minutes").notNull().default(120),
  postDischargeWrapUpDays: integer("post_discharge_wrap_up_days").notNull().default(7),
  defaultCoordinatorMembershipId: uuid("default_coordinator_membership_id").notNull(), // M1 membership (no cross-module FK)
  active: boolean("active").notNull().default(true),
  version: integer("version").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type IdgRecurringPolicy = typeof idgRecurringPolicy.$inferSelect;
export type NewIdgRecurringPolicy = typeof idgRecurringPolicy.$inferInsert;
