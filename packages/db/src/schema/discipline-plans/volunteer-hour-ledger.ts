// @chartwarden/db — `volunteer_hour_ledger` (M15 §3.3). The materialized numerator of the 42 CFR §418.78(e)
// 5% volunteer-time ratio: ONE row per (provider_entity_id, fiscal_year) holding the summed minutes and the
// `as_of_at` watermark the nightly aggregator advances (§2.2.7).
//
// M15-F04 / §7.6: the DENOMINATOR (staff patient-care minutes, from M8's signed-encounter digests through
// the SignedEncountersReader seam) is computed ONCE per (provider entity × fiscal year) by the nightly hour
// aggregator and persisted in the `patient_care_*` columns (migration 0347); the read paths read it back.
// Null / never computed surfaces as null behind the explicit "cost basis unavailable" badge rather than as a
// fabricated percentage.
//
// Tenancy: PE-scoped aggregate, no patient reference → organization_id + provider_entity_id (location is
// not a dimension of the CoP ratio, which is computed per certified provider). RLS keys on app.org_id.
import { sql } from "drizzle-orm";
import { bigint, check, integer, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const volunteerHourLedger = pgTable(
  "volunteer_hour_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),

    fiscalYear: bigint("fiscal_year", { mode: "number" }).notNull(),
    totalVolunteerHourMinutes: bigint("total_volunteer_hour_minutes", { mode: "number" })
      .notNull()
      .default(0),
    asOfAt: timestamp("as_of_at", { withTimezone: true }).notNull().defaultNow(),

    // 0347 — the persisted 418.78(e) denominator (nullable: null = never computed / nothing resolved).
    patientCareMinutes: bigint("patient_care_minutes", { mode: "number" }),
    patientCareVisitsCounted: integer("patient_care_visits_counted"),
    patientCareVisitsUnresolved: integer("patient_care_visits_unresolved"),
    patientCareComputedAt: timestamp("patient_care_computed_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigint("version", { mode: "number" }).notNull().default(0), // §2.5 If-Match
  },
  (t) => ({
    pefyUq: uniqueIndex("volunteer_hour_ledger_pe_fy_uq").on(
      t.organizationId,
      t.providerEntityId,
      t.fiscalYear,
    ),
    minutesNonNegative: check(
      "volunteer_hour_ledger_minutes_ck",
      sql`total_volunteer_hour_minutes >= 0`,
    ),
    patientCareNonNegative: check(
      "volunteer_hour_ledger_patient_care_ck",
      sql`(patient_care_minutes IS NULL OR patient_care_minutes >= 0) AND (patient_care_visits_counted IS NULL OR patient_care_visits_counted >= 0) AND (patient_care_visits_unresolved IS NULL OR patient_care_visits_unresolved >= 0)`,
    ),
    fiscalYearRange: check(
      "volunteer_hour_ledger_fiscal_year_ck",
      sql`fiscal_year BETWEEN 2000 AND 2200`,
    ),
  }),
);

export type VolunteerHourLedger = typeof volunteerHourLedger.$inferSelect;
export type NewVolunteerHourLedger = typeof volunteerHourLedger.$inferInsert;
