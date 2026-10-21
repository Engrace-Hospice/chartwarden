import { sql } from "drizzle-orm";
// @chartwarden/db — M37 clinical-safety overlays (§2.5/§2.10, §3.3): ipu_iv_safety_overlay (the IV-pump
// safety overlay that CLOSES the M13 Wave-E deferral), ipu_restraint_event + its reassessment cadence
// ledger. TENANT-SCOPED, RLS on app.org_id. Restraint application is a step-up action — the
// applied_step_up_assertion_id is NOT NULL. Free-text justification/notes/reason is PHI-denylisted
// (D11, §3.6); the char_length CHECKs (justification >= 100) live in the migration. order_id /
// ordering_order_id are logical M11 order uuids; ipu_admission_id / restraint_event_id are REAL FKs.
import {
  boolean,
  index,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  ipuRestraintEventState,
  ipuRestraintKind,
  ipuRestraintReassessmentOutcome,
} from "../../enums";
import { ipuAdmission } from "./admission";
import { bigintVersion } from "./shared";

export const ipuIvSafetyOverlay = pgTable(
  "ipu_iv_safety_overlay",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    ipuAdmissionId: uuid("ipu_admission_id")
      .notNull()
      .references(() => ipuAdmission.id, { onDelete: "restrict" }),
    orderId: uuid("order_id").notNull(), // M11 order_record
    medicationRxNormCode: text("medication_rx_norm_code").notNull(), // M38-validated
    titrationMinRate: numeric("titration_min_rate", { precision: 10, scale: 4 }),
    titrationMaxRate: numeric("titration_max_rate", { precision: 10, scale: 4 }),
    rateUnit: text("rate_unit").notNull(),
    dualWitnessRequired: boolean("dual_witness_required").notNull().default(false),
    maxContinuousDurationHours: smallint("max_continuous_duration_hours").notNull().default(168),
    bedsideCheckIntervalMinutes: smallint("bedside_check_interval_minutes").notNull(),
    isSedationClass: boolean("is_sedation_class").notNull().default(false),
    overlayActive: boolean("overlay_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    onePerOrderUq: uniqueIndex("iv_overlay_one_per_order").on(t.orderId),
    admissionIx: index("iv_overlay_admission_idx").on(t.ipuAdmissionId).where(sql`overlay_active`),
  }),
);

export const ipuRestraintEvent = pgTable(
  "ipu_restraint_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    ipuAdmissionId: uuid("ipu_admission_id")
      .notNull()
      .references(() => ipuAdmission.id, { onDelete: "restrict" }),
    restraintKind: ipuRestraintKind("restraint_kind").notNull(),
    restraintJustificationText: text("restraint_justification_text").notNull(), // >= 100 chars; PHI denylisted
    orderingPhysicianId: uuid("ordering_physician_id").notNull(),
    orderingOrderId: uuid("ordering_order_id").notNull(), // M11 order
    appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
    appliedByMembershipId: uuid("applied_by_membership_id").notNull(),
    appliedStepUpAssertionId: uuid("applied_step_up_assertion_id").notNull(),
    reassessmentIntervalMinutes: smallint("reassessment_interval_minutes").notNull(),
    state: ipuRestraintEventState("state").notNull().default("active"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedByMembershipId: uuid("released_by_membership_id"),
    releasedReason: text("released_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    admissionStateIx: index("restraint_event_admission_state_idx")
      .on(t.ipuAdmissionId, t.state)
      .where(sql`state = 'active'`),
    activeIx: index("restraint_event_active_idx").on(t.appliedAt).where(sql`state = 'active'`),
  }),
);

export const ipuRestraintReassessment = pgTable(
  "ipu_restraint_reassessment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    restraintEventId: uuid("restraint_event_id")
      .notNull()
      .references(() => ipuRestraintEvent.id, { onDelete: "restrict" }),
    reassessedAt: timestamp("reassessed_at", { withTimezone: true }).notNull().defaultNow(),
    reassessedByMembershipId: uuid("reassessed_by_membership_id").notNull(),
    outcome: ipuRestraintReassessmentOutcome("outcome").notNull(),
    notes: text("notes"), // PHI denylisted
    nextDueAt: timestamp("next_due_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    eventAtIx: index("restraint_reassessment_event_at_idx").on(t.restraintEventId, t.reassessedAt),
  }),
);

export type IpuIvSafetyOverlayRow = typeof ipuIvSafetyOverlay.$inferSelect;
export type NewIpuIvSafetyOverlayRow = typeof ipuIvSafetyOverlay.$inferInsert;
export type IpuRestraintEventRow = typeof ipuRestraintEvent.$inferSelect;
export type NewIpuRestraintEventRow = typeof ipuRestraintEvent.$inferInsert;
export type IpuRestraintReassessmentRow = typeof ipuRestraintReassessment.$inferSelect;
export type NewIpuRestraintReassessmentRow = typeof ipuRestraintReassessment.$inferInsert;
