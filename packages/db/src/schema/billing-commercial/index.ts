// @chartwarden/db — M41 Billing — Commercial: payer and plan model (migration 1260, issue #721). Three org-scoped tables:
// commercial_payer_plan, commercial_payer_route, commercial_contract_rate. NO PHI in any of them.
//
// Tenancy (ADR-0010): organization_id NOT NULL, canonical app.org_id RLS, FORCEd. `payer_id` is a LOGICAL id of an M40
// canonical payer (cross-module FK forbidden); a trigger in the migration proves it is an active commercial payer. Closed
// sets are text + CHECK mirrored in @chartwarden/types (commercial-billing.ts), so there is no pgEnum. The no-overlap
// EXCLUDE constraints (effective dating) live in the migration; Drizzle carries the logical shape only.
import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const commercialPayerPlan = pgTable(
  "commercial_payer_plan",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    payerId: uuid("payer_id").notNull(), // M40 payer (logical FK)
    planName: text("plan_name").notNull(),
    claimFilingIndicator: text("claim_filing_indicator").notNull(), // CommercialClaimFilingIndicator
    authorizationRequirement: text("authorization_requirement")
      .notNull()
      .default("confirm_with_payer"),
    authorizationLeadDays: smallint("authorization_lead_days"),
    siteOfServiceHcpcsRequired: boolean("site_of_service_hcpcs_required").notNull().default(false), // migration 1261
    // #724 (migration 1265): what stale or missing eligibility does to claim validation, and how old makes a check stale.
    eligibilityStalenessPolicy: text("eligibility_staleness_policy").notNull().default("warn"), // CommercialEligibilityStalenessPolicy
    eligibilityMaxAgeDays: smallint("eligibility_max_age_days").notNull().default(30),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrgPayer: index("commercial_payer_plan_org_payer_ix").on(t.organizationId, t.payerId),
  }),
);

export const commercialPayerRoute = pgTable(
  "commercial_payer_route",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    planId: uuid("plan_id").notNull(), // composite FK (plan_id, organization_id) in the migration
    clearinghouseKey: text("clearinghouse_key").notNull(),
    clearinghousePayerId: text("clearinghouse_payer_id").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byPlan: index("commercial_payer_route_plan_ix").on(t.planId),
    byOrg: index("commercial_payer_route_org_ix").on(t.organizationId),
  }),
);

export const commercialContractRate = pgTable(
  "commercial_contract_rate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    planId: uuid("plan_id").notNull(),
    levelOfCare: text("level_of_care").notNull(), // CommercialHospiceLevelOfCare
    revenueCode: text("revenue_code").notNull(),
    rateBasis: text("rate_basis").notNull(), // CommercialRateBasis
    rateCents: integer("rate_cents"),
    percentOfCharges: numeric("percent_of_charges", { precision: 5, scale: 2 }),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byPlan: index("commercial_contract_rate_plan_ix").on(t.planId),
    byOrg: index("commercial_contract_rate_org_ix").on(t.organizationId),
  }),
);

// #724 (migration 1265): a provider entity's enrollment with a payer on a clearinghouse. No PHI. The no-overlap EXCLUDE lives in the migration.
export const commercialPayerEnrollment = pgTable(
  "commercial_payer_enrollment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // M1 provider entity (logical FK)
    payerId: uuid("payer_id").notNull(), // M40 payer (logical FK)
    clearinghouseKey: text("clearinghouse_key").notNull(),
    status: text("status").notNull().default("not_enrolled"), // CommercialEnrollmentStatus
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    evidenceRef: text("evidence_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrg: index("commercial_payer_enrollment_org_ix").on(t.organizationId),
    byLookup: index("commercial_payer_enrollment_lookup_ix").on(
      t.organizationId,
      t.providerEntityId,
      t.payerId,
      t.clearinghouseKey,
    ),
  }),
);

// #724 (migration 1265): one 270/271 exchange. Append-only. Outcome and as-of date ONLY: never the member id, never the 271 body.
export const commercialEligibilityCheck = pgTable(
  "commercial_eligibility_check",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").notNull(), // logical FK (M1)
    locationId: uuid("location_id"), // logical FK (M1)
    patientId: uuid("patient_id").notNull(), // logical FK (M5)
    planId: uuid("plan_id").notNull(), // composite FK (plan_id, organization_id) in the migration
    patientPayerId: uuid("patient_payer_id").notNull(), // the M5 coverage row used (an id, never the member id)
    clearinghouseKey: text("clearinghouse_key").notNull(),
    clearinghousePayerId: text("clearinghouse_payer_id").notNull(),
    serviceDate: date("service_date").notNull(),
    outcome: text("outcome").notNull(), // CommercialEligibilityOutcome
    asOfDate: date("as_of_date").notNull(),
    requestId: uuid("request_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    checkedByUserId: uuid("checked_by_user_id").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrg: index("commercial_eligibility_check_org_ix").on(t.organizationId),
    byPatientRecent: index("commercial_eligibility_check_patient_recent_ix").on(
      t.organizationId,
      t.patientId,
      t.planId,
      t.checkedAt,
    ),
    byPlan: index("commercial_eligibility_check_plan_ix").on(t.planId),
  }),
);

export type CommercialPayerEnrollment = typeof commercialPayerEnrollment.$inferSelect;
export type CommercialEligibilityCheck = typeof commercialEligibilityCheck.$inferSelect;
export type CommercialPayerPlan = typeof commercialPayerPlan.$inferSelect;
export type NewCommercialPayerPlan = typeof commercialPayerPlan.$inferInsert;
export type CommercialPayerRoute = typeof commercialPayerRoute.$inferSelect;
export type CommercialContractRate = typeof commercialContractRate.$inferSelect;

export * from "./claims";
export * from "./submission";
export * from "./acknowledgment";
