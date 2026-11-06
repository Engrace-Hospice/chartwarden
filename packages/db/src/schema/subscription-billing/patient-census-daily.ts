// @chartwarden/db — `patient_census_daily` (M35, slice 2 — migration 1342). One row per organisation per UTC day: the
// active-patient COUNT the `m35.patient-census` sweep read from M5's PatientCensusReader (the latest observation of the day
// wins). The average daily census is the mean of these rows. A count only: no patient id, pseudonym or name, so it is not
// PHI-bearing. TENANT-SCOPED, SELECT-ONLY to the app role (a tenant cannot write the census it is billed on).
import { date, integer, pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";

export const patientCensusDaily = pgTable(
  "patient_census_daily",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    censusDate: date("census_date", { mode: "string" }).notNull(),
    activePatientCount: integer("active_patient_count").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgDateUq: unique("patient_census_daily_org_date_uq").on(t.organizationId, t.censusDate),
  }),
);

export type PatientCensusDailyRow = typeof patientCensusDaily.$inferSelect;
export type NewPatientCensusDailyRow = typeof patientCensusDaily.$inferInsert;
