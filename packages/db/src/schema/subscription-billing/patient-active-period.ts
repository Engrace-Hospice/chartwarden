import { sql } from "drizzle-orm";
// @wardenx/db — `patient_active_period` (M35 §3.3). TENANT-SCOPED, RLS on app.org_id (0143). Pseudonymized
// — NEVER holds a raw patient_id, only a 32-hex HMAC-SHA256 `patient_pseudonym` (privacy, W-SB-08). It is
// therefore NOT PHI-bearing by the tenancy gate's heuristic (no patient_id/mrn/clinical column). §3.6
// requests full audit exclusion (append-only pseudonym rows; the M35 eraser destroys them). `organization_id`
// is a logical uuid (M35-F04).
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { inactivityReason } from "../../enums";

export const patientActivePeriod = pgTable(
  "patient_active_period",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    patientPseudonym: text("patient_pseudonym").notNull(),
    pseudonymKeyEpoch: text("pseudonym_key_epoch").notNull(),
    periodYearMonth: text("period_year_month").notNull(),
    wasActive: boolean("was_active").notNull().default(false),
    becameActiveAt: timestamp("became_active_at", { withTimezone: true }),
    becameInactiveAt: timestamp("became_inactive_at", { withTimezone: true }),
    inactivityReason: inactivityReason("inactivity_reason"),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pseudoUq: uniqueIndex("patient_active_period_uq").on(
      t.organizationId,
      t.patientPseudonym,
      t.periodYearMonth,
    ),
    orgPeriodIx: index("patient_active_period_org_period_ix").on(
      t.organizationId,
      t.periodYearMonth,
    ),
    pseudonymFormatCk: check(
      "patient_active_period_pseudonym_format_ck",
      sql`patient_pseudonym ~ '^[a-f0-9]{32}$'`,
    ),
  }),
);

export type PatientActivePeriodRow = typeof patientActivePeriod.$inferSelect;
export type NewPatientActivePeriodRow = typeof patientActivePeriod.$inferInsert;
