// @chartwarden/db — M41 Billing - Commercial: claim assembly and validation (migration 1261, issue #722). PHI-bearing
// (a claim names a patient): organization_id, provider_entity_id and location_id on every table, canonical app.org_id
// RLS (FORCEd), write-audit triggers that scrub clinical content and free text. Closed sets are text + CHECK mirrored in
// @chartwarden/types (commercial-claim.ts). Logical ids (patient, admission, coverage) carry no cross-module FK.
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

const scope = {
  organizationId: uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "restrict" }),
  providerEntityId: uuid("provider_entity_id")
    .notNull()
    .references(() => providerEntities.id, { onDelete: "restrict" }),
  locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
};

export const commercialAuthorizations = pgTable(
  "commercial_authorization",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...scope,
    patientId: uuid("patient_id").notNull(),
    planId: uuid("plan_id").notNull(), // composite FK (plan_id, organization_id) in the migration
    authorizationNumber: text("authorization_number").notNull(),
    levelOfCare: text("level_of_care"), // null = every level; CommercialHospiceLevelOfCare
    status: text("status").notNull().default("approved"), // CommercialAuthorizationStatus
    obtainedOn: date("obtained_on").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byPlan: index("commercial_authorization_plan_ix").on(t.planId),
    byPatient: index("commercial_authorization_patient_ix").on(t.organizationId, t.patientId),
  }),
);

export const commercialClaims = pgTable(
  "commercial_claim",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...scope,
    patientId: uuid("patient_id").notNull(),
    admissionId: uuid("admission_id").notNull(),
    planId: uuid("plan_id").notNull(),
    primaryPatientPayerId: uuid("primary_patient_payer_id").notNull(),
    secondaryPatientPayerId: uuid("secondary_patient_payer_id"),
    secondaryPayerKind: text("secondary_payer_kind"), // CommercialSecondaryPayerKind
    claimFilingIndicator: text("claim_filing_indicator").notNull(),
    clearinghouseKey: text("clearinghouse_key"),
    clearinghousePayerId: text("clearinghouse_payer_id"),
    tob: char("tob", { length: 3 }).notNull(),
    frequencyCode: char("frequency_code", { length: 1 }).notNull(),
    serviceFrom: date("service_from").notNull(),
    serviceTo: date("service_to").notNull(),
    admissionDate: date("admission_date").notNull(),
    admissionTypeCode: text("admission_type_code"),
    admissionSourceCode: text("admission_source_code"),
    patientStatusCode: text("patient_status_code").notNull(),
    claimControlNumber: text("claim_control_number").notNull(),
    diagnoses: jsonb("diagnoses").notNull().default([]),
    attendingNpi: text("attending_npi"),
    attendingFirstName: text("attending_first_name"),
    attendingLastName: text("attending_last_name"),
    totalChargeCents: bigint("total_charge_cents", { mode: "number" }).notNull(),
    expectedPaymentCents: bigint("expected_payment_cents", { mode: "number" }),
    state: text("state").notNull().default("draft"), // CommercialClaimState
    /** The payer's own claim number (835 CLP07), captured from the first posted line (migration 1283). Nullable; a lookup key per tenant. */
    payerIcn: text("payer_icn"),
    latestValidationRunId: uuid("latest_validation_run_id"),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    createdByMembershipId: uuid("created_by_membership_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byPlan: index("commercial_claim_plan_ix").on(t.planId),
    byPatient: index("commercial_claim_patient_ix").on(
      t.organizationId,
      t.patientId,
      t.serviceFrom,
    ),
    byPayerIcn: index("commercial_claim_payer_icn_ix")
      .on(t.organizationId, t.payerIcn)
      .where(sql`payer_icn IS NOT NULL`),
  }),
);

export const commercialClaimLines = pgTable(
  "commercial_claim_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...scope,
    claimId: uuid("claim_id").notNull(),
    lineNumber: integer("line_number").notNull(),
    levelOfCare: text("level_of_care").notNull(),
    revenueCode: text("revenue_code").notNull(),
    hcpcsCode: text("hcpcs_code"),
    serviceFrom: date("service_from").notNull(),
    serviceTo: date("service_to").notNull(),
    units: integer("units").notNull(),
    unitRateCents: bigint("unit_rate_cents", { mode: "number" }),
    lineChargeCents: bigint("line_charge_cents", { mode: "number" }).notNull(),
    contractRateId: uuid("contract_rate_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrg: index("commercial_claim_line_org_ix").on(t.organizationId),
  }),
);

export const commercialClaimStateHistory = pgTable(
  "commercial_claim_state_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...scope,
    claimId: uuid("claim_id").notNull(),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorMembershipId: uuid("actor_membership_id"),
    validationRunId: uuid("validation_run_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byClaim: index("commercial_claim_state_history_claim_ix").on(t.claimId, t.createdAt),
  }),
);

export const commercialValidationRuns = pgTable(
  "commercial_validation_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...scope,
    claimId: uuid("claim_id").notNull(),
    trigger: text("trigger").notNull(), // CommercialValidationTrigger
    outcome: text("outcome").notNull(), // all_pass | failures_present
    ruleSetVersion: integer("rule_set_version").notNull(),
    rulesExecuted: integer("rules_executed").notNull(),
    rulesFailed: integer("rules_failed").notNull(),
    initiatedByMembershipId: uuid("initiated_by_membership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byClaim: index("commercial_validation_run_claim_ix").on(t.claimId, t.createdAt),
  }),
);

export const commercialValidationResults = pgTable(
  "commercial_validation_result",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...scope,
    claimId: uuid("claim_id").notNull(),
    validationRunId: uuid("validation_run_id").notNull(),
    ruleKey: text("rule_key").notNull(),
    severity: text("severity").notNull(), // CommercialValidationSeverity
    outcome: text("outcome").notNull(), // CommercialValidationOutcome
    overridable: boolean("overridable").notNull(),
    evidenceHash: char("evidence_hash", { length: 64 }).notNull(),
    message: text("message").notNull(),
    evidence: jsonb("evidence").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byClaim: index("commercial_validation_result_claim_ix").on(t.claimId),
  }),
);

export const commercialValidationOverrides = pgTable(
  "commercial_validation_override",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ...scope,
    claimId: uuid("claim_id").notNull(),
    validationResultId: uuid("validation_result_id").notNull(),
    ruleKey: text("rule_key").notNull(),
    evidenceHash: char("evidence_hash", { length: 64 }).notNull(),
    overrideMembershipId: uuid("override_membership_id").notNull(),
    reason: text("reason").notNull(),
    m4AuditEventId: uuid("m4_audit_event_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byOrg: index("commercial_validation_override_org_ix").on(t.organizationId),
  }),
);

export type CommercialAuthorization = typeof commercialAuthorizations.$inferSelect;
export type CommercialClaim = typeof commercialClaims.$inferSelect;
export type NewCommercialClaim = typeof commercialClaims.$inferInsert;
export type CommercialClaimLine = typeof commercialClaimLines.$inferSelect;
export type NewCommercialClaimLine = typeof commercialClaimLines.$inferInsert;
export type CommercialValidationResult = typeof commercialValidationResults.$inferSelect;
export type CommercialValidationOverride = typeof commercialValidationOverrides.$inferSelect;
