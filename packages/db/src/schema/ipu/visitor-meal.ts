import { sql } from "drizzle-orm";
// @chartwarden/db — M37 visitor tracking + meal service (§2.7/§2.8, §3.3): ipu_visitor (MONTHLY-PARTITIONED
// by checked_in_at, composite PK `(id, checked_in_at)` in SQL 0149), ipu_visitor_restriction (unit- or
// patient-scoped), ipu_meal_service (MONTHLY-PARTITIONED by service_date). TENANT-SCOPED, RLS on
// app.org_id. visitor_name / relationship_other_text / restriction_applied_text / rationale /
// refusal_reason are PHI-denylisted (D11, §3.6). The scope-XOR CHECK on ipu_visitor_restriction and the
// intake_fraction BETWEEN 0..1 CHECK live in the migration. Partitioned-table audit triggers are
// GENERATED functions that hard-code the parent name (the M32 ai_token_ledger lesson).
import {
  boolean,
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  ipuMealSlot,
  ipuVisitorRelationship,
  ipuVisitorRestrictionKind,
  ipuVisitorRestrictionScope,
} from "../../enums";
import { bigintVersion } from "./shared";
import { inpatientUnit } from "./units";

// MONTHLY-PARTITIONED by checked_in_at; composite PK (id, checked_in_at) declared in migration 0149.
export const ipuVisitor = pgTable(
  "ipu_visitor",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    ipuAdmissionId: uuid("ipu_admission_id").notNull(),
    visitorName: text("visitor_name").notNull(), // PHI denylisted
    relationship: ipuVisitorRelationship("relationship").notNull(),
    relationshipOtherText: text("relationship_other_text"), // PHI denylisted
    screeningOutcome: jsonb("screening_outcome").notNull(), // TypeBox-validated
    consentEvaluatorResult: jsonb("consent_evaluator_result").notNull(), // M39 result
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }).notNull().defaultNow(), // PARTITION KEY
    checkedInBy: uuid("checked_in_by").notNull(),
    checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),
    maskRequired: boolean("mask_required").notNull().default(false),
    restrictionAppliedText: text("restriction_applied_text"), // PHI denylisted
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    admissionCheckedInIx: index("ipu_visitor_admission_checked_in_idx").on(
      t.ipuAdmissionId,
      t.checkedInAt,
    ),
  }),
);

export const ipuVisitorRestriction = pgTable(
  "ipu_visitor_restriction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    // ARCH-011 three-column rule (patient-bearing via the scope='patient' branch). Nullable here because a
    // scope='unit' restriction has no patient/provider-entity; the scope-XOR CHECK (migration) governs.
    providerEntityId: uuid("provider_entity_id"),
    locationId: uuid("location_id"),
    scope: ipuVisitorRestrictionScope("scope").notNull(),
    unitId: uuid("unit_id").references(() => inpatientUnit.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id"),
    restrictionKind: ipuVisitorRestrictionKind("restriction_kind").notNull(),
    rationale: text("rationale").notNull(), // PHI denylisted
    appliedBy: uuid("applied_by").notNull(),
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
    appliedUntil: timestamp("applied_until", { withTimezone: true }),
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
    liftedBy: uuid("lifted_by"),
    sourceKind: text("source_kind").notNull(), // compliance_action | outbreak_surveillance | per_patient_clinical
    sourceEventId: uuid("source_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    activeUnitIx: index("visitor_restriction_active_unit_idx")
      .on(t.unitId)
      .where(sql`lifted_at IS NULL AND scope = 'unit'`),
    activePatientIx: index("visitor_restriction_active_patient_idx")
      .on(t.patientId)
      .where(sql`lifted_at IS NULL AND scope = 'patient'`),
  }),
);

// MONTHLY-PARTITIONED by service_date; composite PK (id, service_date) declared in migration 0149.
export const ipuMealService = pgTable(
  "ipu_meal_service",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    ipuAdmissionId: uuid("ipu_admission_id").notNull(),
    serviceDate: date("service_date").notNull(), // PARTITION KEY
    mealSlot: ipuMealSlot("meal_slot").notNull(),
    dietOrderId: uuid("diet_order_id"), // M11
    trayDeliveredAt: timestamp("tray_delivered_at", { withTimezone: true }),
    trayRemovedAt: timestamp("tray_removed_at", { withTimezone: true }),
    intakeFraction: numeric("intake_fraction", { precision: 3, scale: 2 }), // BETWEEN 0 AND 1 (migration CHECK)
    refusalReason: text("refusal_reason"), // M38 value-set; PHI denylisted
    caregiverAssistedFeeding: boolean("caregiver_assisted_feeding").notNull().default(false),
    oralCareCompleted: boolean("oral_care_completed").notNull().default(false),
    recordedBy: uuid("recorded_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    admissionDateIx: index("ipu_meal_service_admission_date_idx").on(
      t.ipuAdmissionId,
      t.serviceDate,
    ),
  }),
);

export type IpuVisitorRow = typeof ipuVisitor.$inferSelect;
export type NewIpuVisitorRow = typeof ipuVisitor.$inferInsert;
export type IpuVisitorRestrictionRow = typeof ipuVisitorRestriction.$inferSelect;
export type NewIpuVisitorRestrictionRow = typeof ipuVisitorRestriction.$inferInsert;
export type IpuMealServiceRow = typeof ipuMealService.$inferSelect;
export type NewIpuMealServiceRow = typeof ipuMealService.$inferInsert;
