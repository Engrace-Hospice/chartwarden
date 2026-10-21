// @chartwarden/db — `recurring_visit` (M17 §3.3 / §2.2.3 D4). The source-of-truth policy row for a recurring
// cadence: the RFC 5545 RRULE subset (FREQ=DAILY|WEEKLY with BYDAY/INTERVAL/UNTIL/COUNT only — D4), the
// time-of-day window + tz, and the active → discontinued lifecycle (discontinue cascade-cancels future
// child visits, §7.7). Concrete visits are materialized as `visit` rows on a rolling 90-day horizon (D4) —
// this row is editable and stays authoritative. PHI-bearing (patient_id / admission_id) → M17-F01 three
// tenancy columns, provider_entity_id + location_id NOT NULL. Cross-module logical FKs (M5 patient, M6
// admission) are plain uuid; the tenancy spine + M1 membership assignment carry SQL FKs. Not partitioned
// (low volume — ~3 per admission, D14). RLS + grants + the M4 write-audit trigger land in M17-T02.
import { date, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { recurringVisitStatus, visitPurpose, visitSetting } from "../../enums";
import { locations } from "../locations";
import { memberships } from "../memberships";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const recurringVisit = pgTable(
  "recurring_visit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    admissionId: uuid("admission_id").notNull(), // M6 admission (app-validated; no cross-module FK)
    assignedMembershipId: uuid("assigned_membership_id")
      .notNull()
      .references(() => memberships.id, { onDelete: "restrict" }),
    visitPurpose: visitPurpose("visit_purpose").notNull(),
    visitSetting: visitSetting("visit_setting").notNull(),
    patientAddressId: uuid("patient_address_id"),
    externalFacilityId: uuid("external_facility_id"),

    rrule: text("rrule").notNull(), // validated RRULE subset (D4)
    byday: text("byday").array(), // ['MO','WE','FR'] for WEEKLY
    timeOfDayStart: text("time_of_day_start").notNull(), // 'HH:MM' in tz
    timeOfDayEnd: text("time_of_day_end").notNull(),
    timeZone: text("time_zone").notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"), // CHECK: end_date IS NULL OR count IS NULL (app-enforced)
    count: integer("count"),

    status: recurringVisitStatus("status").notNull().default("active"),
    discontinuedAt: timestamp("discontinued_at", { withTimezone: true }),
    discontinuedBy: uuid("discontinued_by"),

    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgPatientStatus: index("rv_org_patient_status_idx").on(
      t.organizationId,
      t.patientId,
      t.status,
    ),
  }),
);

export type RecurringVisit = typeof recurringVisit.$inferSelect;
export type NewRecurringVisit = typeof recurringVisit.$inferInsert;
