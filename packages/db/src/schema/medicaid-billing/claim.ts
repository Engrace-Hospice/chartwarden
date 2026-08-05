// @wardenx/db — M24 Billing — Medicaid §3.3 — the claim root, its service-date lines, and the
// line↔encounter join. medicaid_claim is PARTITION BY LIST(provider_entity_id) (per-CCN tenancy spine,
// §3.3 tenancy note); medicaid_claim_line is PARTITION BY LIST(provider_entity_id) too — both carry a
// composite PK (id, provider_entity_id) including the partition key, declared in SQL (0094). Drizzle here
// is the LOGICAL shape only; partition DDL, the DEFAULT partition, RLS, grants and M4 write-audit land in SQL.
//
// CROSS-MODULE FK POLICY (architecture wins — cross-module FK constraints are FORBIDDEN; partitioned-parent
// FKs are impossible by single column anyway): only organization_id / provider_entity_id / location_id (M1
// core) get real `.references(...)`. patient_id / patient_payer_id (M5), admission_id / loc_period_id (M6),
// encounter_id (M8), medicare_claim_id (M23 dual-eligible COB), state_plan_code_id / mco_id /
// state_rate_schedule_id_snapshot (M40), rb_arrangement_id / rb_day_id / eligibility_check_id /
// validation_run_id_latest / replaces_claim_id / replaced_by_claim_id (intra-M24, but partitioned or
// snapshot) are LOGICAL uuid. State Medicaid Recipient ID is NEVER stored here (only masked at eligibility).
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { m24ClaimKind, m24ClaimLineLoc, m24ClaimState } from "./enums";

// ---- medicaid_claim — claim root; PARTITION BY LIST(provider_entity_id) ----
export const medicaidClaim = pgTable(
  "medicaid_claim",
  {
    id: uuid("id").primaryKey().defaultRandom(), // composite PK (id, provider_entity_id) declared in SQL
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }), // partition key
    locationId: uuid("location_id").references(() => locations.id), // nullable — claim is PE-scoped (§3.3)
    patientId: uuid("patient_id").notNull(), // logical FK → M5
    patientPayerId: uuid("patient_payer_id").notNull(), // logical FK → M5
    admissionId: uuid("admission_id").notNull(), // logical FK → M6

    serviceState: varchar("service_state", { length: 2 }).notNull(),
    kind: m24ClaimKind("kind").notNull(),
    tob: varchar("tob", { length: 4 }).notNull(),

    serviceFrom: timestamp("service_from", { withTimezone: true, mode: "date" }).notNull(),
    serviceTo: timestamp("service_to", { withTimezone: true, mode: "date" }).notNull(),

    statePlanCodeId: uuid("state_plan_code_id").notNull(), // logical FK → M40
    statePlanCodeSnapshot: varchar("state_plan_code_snapshot", { length: 32 }).notNull(),

    mcoId: uuid("mco_id"), // null = FFS / Open Card
    mcoSnapshot: jsonb("mco_snapshot"),

    medicareClaimId: uuid("medicare_claim_id"), // logical FK → M23 (dual-eligible COB)
    medicareSecondaryContextSnapshot: jsonb("medicare_secondary_context_snapshot"),

    rbArrangementId: uuid("rb_arrangement_id"), // logical FK → rb_arrangement
    rbDayCountSnapshot: integer("rb_day_count_snapshot"),

    replacesClaimId: uuid("replaces_claim_id"),
    replacedByClaimId: uuid("replaced_by_claim_id"),

    medicaidClaimControlNumber: varchar("medicaid_claim_control_number", { length: 32 }).notNull(),

    state: m24ClaimState("state").notNull().default("DRAFT"),
    version: integer("version").notNull().default(1),

    eligibilityCheckId: uuid("eligibility_check_id"),
    eligibilityOutcomeSnapshot: varchar("eligibility_outcome_snapshot", { length: 32 }),
    eligibilityCheckedAtSnapshot: timestamp("eligibility_checked_at_snapshot", {
      withTimezone: true,
    }),

    validationRunIdLatest: uuid("validation_run_id_latest"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    updatedByMembershipId: uuid("updated_by_membership_id").notNull(),
  },
  (t) => ({
    // unique control number per (PE, state) — includes the partition key (provider_entity_id)
    controlPerPeState: index("medicaid_claim_control_per_pe_state").on(
      t.providerEntityId,
      t.serviceState,
      t.medicaidClaimControlNumber,
    ),
    byOrgStatePending: index("medicaid_claim_by_org_state").on(t.organizationId, t.state),
    byReplaces: index("medicaid_claim_by_replaces").on(t.replacesClaimId),
    byMedicarePrimary: index("medicaid_claim_by_medicare_primary").on(
      t.organizationId,
      t.medicareClaimId,
    ),
    replacementRequiresPredecessor: check(
      "medicaid_claim_replacement_requires_predecessor",
      sql`(tob IN ('817','818') AND replaces_claim_id IS NOT NULL) OR (tob NOT IN ('817','818') AND replaces_claim_id IS NULL)`,
    ),
    medicareSecondaryRequiresFk: check(
      "medicare_secondary_requires_medicare_fk",
      sql`(medicare_secondary_context_snapshot IS NULL AND medicare_claim_id IS NULL) OR (medicare_secondary_context_snapshot IS NOT NULL AND medicare_claim_id IS NOT NULL)`,
    ),
    serviceRangeValid: check("medicaid_claim_service_range_valid", sql`service_from <= service_to`),
  }),
);

// ---- medicaid_claim_line — service-date lines; PARTITION BY LIST(provider_entity_id) ----
export const medicaidClaimLine = pgTable(
  "medicaid_claim_line",
  {
    id: uuid("id").primaryKey().defaultRandom(), // composite PK (id, provider_entity_id) in SQL
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }), // partition key (F12)
    locationId: uuid("location_id").references(() => locations.id),
    medicaidClaimId: uuid("medicaid_claim_id").notNull(), // logical FK → medicaid_claim (partitioned)

    lineNumber: integer("line_number").notNull(),
    serviceDate: timestamp("service_date", { withTimezone: true, mode: "date" }).notNull(),

    revenueCode: varchar("revenue_code", { length: 4 }).notNull(),
    qCode: varchar("q_code", { length: 8 }).notNull(),
    hcpcsModifier1: varchar("hcpcs_modifier_1", { length: 2 }),
    hcpcsModifier2: varchar("hcpcs_modifier_2", { length: 2 }),
    hcpcsModifier3: varchar("hcpcs_modifier_3", { length: 2 }),
    hcpcsModifier4: varchar("hcpcs_modifier_4", { length: 2 }),

    levelOfCare: m24ClaimLineLoc("level_of_care").notNull(),
    locPeriodId: uuid("loc_period_id").notNull(), // logical FK → M6
    units: integer("units").notNull(),

    rateAtAssemblyCents: integer("rate_at_assembly_cents").notNull(),
    // logical FK → medicaid_state_rate_schedule; NULL for an R&B line (rb_day.per_diem_cents_snapshot is
    // the rate source there, not a per-county schedule — see 0178 / the rateScheduleRequiresNonRb CHECK).
    stateRateScheduleIdSnapshot: uuid("state_rate_schedule_id_snapshot"),

    chargesCents: integer("charges_cents").notNull(),
    cobPaidCents: integer("cob_paid_cents"),
    patientResponsibilityCents: integer("patient_responsibility_cents"),

    isRb: boolean("is_rb").notNull().default(false),
    rbDayId: uuid("rb_day_id"), // logical FK → rb_day (partitioned); set when is_rb=true

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniquePerClaim: index("medicaid_claim_line_unique_per_claim").on(
      t.providerEntityId,
      t.medicaidClaimId,
      t.lineNumber,
    ),
    byOrgServiceDate: index("medicaid_claim_line_by_org_service_date").on(
      t.organizationId,
      t.serviceDate,
    ),
    rbLineRequiresRbDay: check(
      "medicaid_claim_line_rb_requires_rb_day",
      sql`(is_rb = false) OR (is_rb = true AND rb_day_id IS NOT NULL)`,
    ),
    rateScheduleRequiresNonRb: check(
      "medicaid_claim_line_rate_schedule_requires_non_rb",
      sql`(is_rb = true) OR (is_rb = false AND state_rate_schedule_id_snapshot IS NOT NULL)`,
    ),
    unitsPositive: check("medicaid_claim_line_units_positive", sql`units > 0`),
    ratePositive: check("medicaid_claim_line_rate_positive", sql`rate_at_assembly_cents > 0`),
  }),
);

// ---- medicaid_claim_line_encounter — line↔encounter join (non-partitioned) ----
export const medicaidClaimLineEncounter = pgTable(
  "medicaid_claim_line_encounter",
  {
    medicaidClaimLineId: uuid("medicaid_claim_line_id").notNull(), // logical FK → medicaid_claim_line (partitioned)
    encounterId: uuid("encounter_id").notNull(), // logical FK → M8
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
  },
  (t) => ({
    uniquePair: index("medicaid_claim_line_encounter_unique").on(
      t.medicaidClaimLineId,
      t.encounterId,
    ),
  }),
);
