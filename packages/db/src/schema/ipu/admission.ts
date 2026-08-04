import { sql } from "drizzle-orm";
// @wardenx/db — M37 IPU admission unit-of-work (§2.2, §3.3): ipu_admission (the aggregate root) plus its
// state-history, bed-assignment, and transition ledgers. TENANT-SCOPED, RLS on app.org_id (0148/0149).
// `ipu_admission_state_history` is MONTHLY-PARTITIONED by `at` (composite PK `(id, at)` in SQL 0149) with
// a GENERATED audit fn. Cross-module ids (patient_id, admission_id/M6, level_of_care_period_id/M6,
// death_event_id/M6, created_by membership) are logical uuids — M37 never FKs into other modules'
// schema (D17 outbox-decoupling). Intra-module links (unit_id, ipu_admission_id, bed_id) are REAL FKs.
// The unit_xor_remote CHECK and the two one-active partial-unique indexes are authoritative in the
// migration; the ORM view carries columns + the indexes Drizzle expresses.
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { ipuAdmissionKind, ipuAdmissionState, ipuAdmissionTransitionKind } from "../../enums";
import { bigintVersion } from "./shared";
import { inpatientUnit, ipuBed } from "./units";

export const ipuAdmission = pgTable(
  "ipu_admission",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    // ARCH-011 three-column rule: a patient-bearing PHI table carries provider_entity_id (M40) +
    // location_id (M2) alongside organization_id. The §3.3 spec sketch omits them; architecture wins.
    // Logical uuids (no ORM FK) to preserve M37's outbox-decoupling (D17).
    providerEntityId: uuid("provider_entity_id").notNull(),
    locationId: uuid("location_id"),
    patientId: uuid("patient_id").notNull(),
    admissionId: uuid("admission_id").notNull(), // M6 admission
    levelOfCarePeriodId: uuid("level_of_care_period_id").notNull(), // M6 LoC period
    unitId: uuid("unit_id").references(() => inpatientUnit.id, { onDelete: "restrict" }),
    remoteFacilityId: uuid("remote_facility_id"), // M40 Facility (arranged)
    kind: ipuAdmissionKind("kind").notNull(),
    state: ipuAdmissionState("state").notNull().default("pending"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    bedAssignedAt: timestamp("bed_assigned_at", { withTimezone: true }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    deathEventId: uuid("death_event_id"), // M6 death event
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    lcpUq: uniqueIndex("ipu_admission_lcp_unique").on(t.levelOfCarePeriodId),
    patientStateIx: index("ipu_admission_patient_state_idx")
      .on(t.patientId, t.state)
      .where(sql`state NOT IN ('closed')`),
    unitStateIx: index("ipu_admission_unit_state_idx")
      .on(t.unitId, t.state)
      .where(sql`state NOT IN ('closed') AND unit_id IS NOT NULL`),
    remoteStateIx: index("ipu_admission_remote_state_idx")
      .on(t.remoteFacilityId, t.state)
      .where(sql`state NOT IN ('closed') AND remote_facility_id IS NOT NULL`),
    lcpIx: index("ipu_admission_lcp_idx").on(t.levelOfCarePeriodId),
  }),
);

// MONTHLY-PARTITIONED by `at`; composite PK (id, at) + PARTITION BY RANGE declared in migration 0149.
export const ipuAdmissionStateHistory = pgTable(
  "ipu_admission_state_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    ipuAdmissionId: uuid("ipu_admission_id").notNull(),
    fromState: ipuAdmissionState("from_state"),
    toState: ipuAdmissionState("to_state").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(), // PARTITION KEY
    byMembershipId: uuid("by_membership_id").notNull(),
    reason: text("reason"),
    metadata: jsonb("metadata"),
  },
  (t) => ({
    admissionAtIx: index("ipu_admission_state_history_admission_at_idx").on(t.ipuAdmissionId, t.at),
  }),
);

export const ipuBedAssignment = pgTable(
  "ipu_bed_assignment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    ipuAdmissionId: uuid("ipu_admission_id")
      .notNull()
      .references(() => ipuAdmission.id, { onDelete: "restrict" }),
    bedId: uuid("bed_id")
      .notNull()
      .references(() => ipuBed.id, { onDelete: "restrict" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    assignedBy: uuid("assigned_by").notNull(),
    unassignReason: text("unassign_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: bigintVersion(),
  },
  (t) => ({
    oneActivePerAdmissionUq: uniqueIndex("ipu_bed_assignment_one_active_per_admission_idx")
      .on(t.ipuAdmissionId)
      .where(sql`ended_at IS NULL`),
    oneActivePerBedUq: uniqueIndex("ipu_bed_assignment_one_active_per_bed_idx")
      .on(t.bedId)
      .where(sql`ended_at IS NULL`),
  }),
);

export const ipuAdmissionTransition = pgTable("ipu_admission_transition", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: uuid("organization_id").notNull(),
  ipuAdmissionId: uuid("ipu_admission_id")
    .notNull()
    .references(() => ipuAdmission.id, { onDelete: "restrict" }),
  kind: ipuAdmissionTransitionKind("kind").notNull(),
  initiatedAt: timestamp("initiated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  destinationUnitId: uuid("destination_unit_id").references(() => inpatientUnit.id),
  destinationFacilityId: uuid("destination_facility_id"),
  reason: text("reason"),
  initiatedBy: uuid("initiated_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  version: bigintVersion(),
});

export type IpuAdmissionRow = typeof ipuAdmission.$inferSelect;
export type NewIpuAdmissionRow = typeof ipuAdmission.$inferInsert;
export type IpuAdmissionStateHistoryRow = typeof ipuAdmissionStateHistory.$inferSelect;
export type NewIpuAdmissionStateHistoryRow = typeof ipuAdmissionStateHistory.$inferInsert;
export type IpuBedAssignmentRow = typeof ipuBedAssignment.$inferSelect;
export type NewIpuBedAssignmentRow = typeof ipuBedAssignment.$inferInsert;
export type IpuAdmissionTransitionRow = typeof ipuAdmissionTransition.$inferSelect;
export type NewIpuAdmissionTransitionRow = typeof ipuAdmissionTransition.$inferInsert;
