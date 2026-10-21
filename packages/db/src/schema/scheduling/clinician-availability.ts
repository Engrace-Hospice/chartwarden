// @chartwarden/db — `clinician_availability` (M17 §3.3 / D7). The positive-declaration availability model: one
// row per clinician per weekly slot ("Sarah is available Mon/Wed 8am–5pm"). The pre-schedule gate checks a
// visit falls inside these bounds (and outside approved `time_off`). Clinician-scoped (membership_id) — NOT
// patient-bearing → org-scoped; the M17-F01 tenancy columns are carried (nullable — a clinician's weekly
// pattern is not bound to a single care location). No free-text fields (empty audit denylist, §3.6). Not
// partitioned (O(clinicians), D14). RLS + grants + the M4 write-audit trigger land in M17-T02.
import { date, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const clinicianAvailability = pgTable(
  "clinician_availability",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // M17-F01: tenancy columns present; nullable (clinician-scoped, not bound to a single care location).
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "cascade" }),

    dayOfWeek: integer("day_of_week").notNull(), // 0=Sun … 6=Sat
    startTime: text("start_time").notNull(), // 'HH:MM' — CHECK: start_time < end_time (app-enforced)
    endTime: text("end_time").notNull(),
    defaultStartLocationId: uuid("default_start_location_id"), // M2 location
    defaultEndLocationId: uuid("default_end_location_id"),
    effectiveStartDate: date("effective_start_date"),
    effectiveEndDate: date("effective_end_date"),

    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    membershipDay: uniqueIndex("ca_membership_day_uidx").on(
      t.membershipId,
      t.dayOfWeek,
      t.effectiveStartDate,
    ),
  }),
);

export type ClinicianAvailability = typeof clinicianAvailability.$inferSelect;
export type NewClinicianAvailability = typeof clinicianAvailability.$inferInsert;
