// @wardenx/db — `administration_policy` (M13 §3.3). Per-tenant configuration (org-scoped, single row per tenant —
// NOT patient-scoped): grace-window defaults, PRN reassessment-window defaults, the materialization window, the
// per-state scope-of-practice overrides (D8 framework, jsonb keyed by state code), and the eMAR-per-admin-PDF flag
// (D9 — off for home, on for IPU). Org-scoped; standard app.org_id RLS. Non-partitioned. RLS + grants + the M4
// write-audit trigger (structural-only; no free-text PHI) land in the RLS migration.
import { sql } from "drizzle-orm";
import { boolean, integer, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const administrationPolicy = pgTable("administration_policy", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" })
    .unique(),

  // Default grace windows (minutes).
  defaultGraceWindowMinutes: integer("default_grace_window_minutes").notNull().default(60),
  controlledGraceWindowMinutes: integer("controlled_grace_window_minutes").notNull().default(30),
  ivContinuousGraceWindowMinutes: integer("iv_continuous_grace_window_minutes")
    .notNull()
    .default(15),

  // Default PRN reassessment windows (minutes).
  defaultPrnReassessmentWindowMinutes: integer("default_prn_reassessment_window_minutes")
    .notNull()
    .default(60),
  sedativePrnReassessmentWindowMinutes: integer("sedative_prn_reassessment_window_minutes")
    .notNull()
    .default(120),
  breakthroughPainPrnReassessmentWindowMinutes: integer(
    "breakthrough_pain_prn_reassessment_window_minutes",
  )
    .notNull()
    .default(30),

  // Materialization.
  materializationWindowDays: integer("materialization_window_days").notNull().default(7),

  // State scope-of-practice overrides (D8 framework): jsonb keyed by state code.
  stateOverrides: jsonb("state_overrides").notNull().default(sql`'{}'::jsonb`),

  // eMAR per-admin PDF render flag (D9 — default off for home; on for IPU).
  emarPerAdministrationPdfEnabled: boolean("emar_per_administration_pdf_enabled")
    .notNull()
    .default(false),

  // GAP-020 -- a BCMA scan must carry a wristband M5 verifies (default TRUE: fail closed). A wristband that WAS
  // scanned and is wrong is refused regardless. This does NOT make a scan mandatory.
  bcmaWristbandRequired: boolean("bcma_wristband_required").notNull().default(true),

  // Caregiver-attested capture.
  caregiverAttestedCaptureEnabled: boolean("caregiver_attested_capture_enabled")
    .notNull()
    .default(true),

  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AdministrationPolicy = typeof administrationPolicy.$inferSelect;
export type NewAdministrationPolicy = typeof administrationPolicy.$inferInsert;
