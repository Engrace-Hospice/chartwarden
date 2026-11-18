// @chartwarden/db — `sia_calculation` (M23 Billing-Medicare §3.3; append-only, non-partitioned; retention class
// `compliance`). Captures the Service Intensity Add-on math for the last-7-days-of-life window (`window_start` =
// deceased date − 6 days, inclusive). ORG-SCOPED: organization_id NOT NULL (canonical app.org_id RLS).
//
// REVISIONS (migrations 1511/1512): 1..n rows per `claim`, UNIQUE (claim_id, revision). A change to a visit fact or the CHC
// rate while the claim is unsubmitted appends a new revision (the table refuses UPDATE); the newest revision is the one the
// claim shows. `basis` says how a row was computed: 'minutes_v1' = legacy minutes-only row (the units columns are NULL),
// 'units_v2' = 15-minute units — paid/eligible/truncated units, the CHC hourly rate and wage index it was priced with, the
// policy assumptions, every visit's counted/excluded verdict and the prior-month advisory.
//
// CROSS-MODULE FK POLICY (architecture WINS): only `organization_id` (core) + `claim_id` (intra-M23)
// get real `.references(...)`. The M8 encounter ids inside `qualifying_visits` / `visit_outcomes` are LOGICAL FKs.
// No MBI is ever stored here (D13, §8.7).
import {
  bigint,
  date,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { claim } from "./claim";
import type {
  SiaCalculationBasis,
  SiaCalculationPolicy,
  SiaCalculationQualifyingVisits,
  SiaCalculationVisitOutcomes,
  SiaPriorClaimAdvisory,
} from "./types";

export const siaCalculation = pgTable(
  "sia_calculation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    claimId: uuid("claim_id")
      .notNull()
      .references(() => claim.id, { onDelete: "restrict" }),

    patientDeceasedDate: date("patient_deceased_date").notNull(),
    windowStart: date("window_start").notNull(), // = deceasedDate - 6 days (inclusive 7-day window)

    // The qualifying (counted) visits, a flat breakdown:
    qualifyingVisits: jsonb("qualifying_visits").$type<SiaCalculationQualifyingVisits>().notNull(), // [{ encounterId, visitDate, discipline, durationMinutes, units?, paidUnits? }]
    totalQualifyingMinutes: integer("total_qualifying_minutes").notNull(),
    siaAddOnCents: bigint("sia_add_on_cents", { mode: "number" }).notNull(),

    // Units snapshot (1511). NULL on a legacy 'minutes_v1' row; the units_v2 CHECK (1512) requires paid/eligible/truncated
    // units, the CHC hourly rate, the policy and the visit outcomes. The wage index columns stay nullable on purpose.
    paidUnits: integer("paid_units"),
    eligibleUnits: integer("eligible_units"),
    truncatedUnits: integer("truncated_units"),
    chcHourlyRateCents: bigint("chc_hourly_rate_cents", { mode: "number" }), // the wage-adjusted CHC hourly rate in cents
    wageIndexFiscalYear: integer("wage_index_fiscal_year"),
    wageIndexFactor: text("wage_index_factor"),
    policy: jsonb("policy").$type<SiaCalculationPolicy>(),
    visitOutcomes: jsonb("visit_outcomes").$type<SiaCalculationVisitOutcomes>(),
    priorClaimAdvisory: jsonb("prior_claim_advisory").$type<SiaPriorClaimAdvisory>(),
    basis: text("basis").$type<SiaCalculationBasis>().notNull().default("minutes_v1"),
    revision: integer("revision").notNull().default(1),

    calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One row per (claim, revision); the newest revision is the claim's current SIA calculation.
    oneRevisionPerClaim: uniqueIndex("sia_calculation_claim_revision_uq").on(t.claimId, t.revision),
  }),
);

export type SiaCalculation = typeof siaCalculation.$inferSelect;
export type NewSiaCalculation = typeof siaCalculation.$inferInsert;
