// @wardenx/db — `discipline_care_plan` (M15 §3.3). The plan ROOT: one row per (admission, kind) for the
// four CoP-driven discipline plans (aide_poc 418.76 · msw_plan 418.64(c) · spiritual_plan 418.64(d) ·
// volunteer_plan 418.78). Bootstrapped on `m6.admission.activated` for the first three kinds, on the first
// volunteer assignment for `volunteer_plan`; §2.2.1 lifecycle draft → active → draft_revising → discharged.
//
// M15-F06 / ADR-0022 D1.1: NOT partitioned. This is a current-state root (≤4 rows per admission) whose
// partial unique index `(organization_id, admission_id, kind) WHERE status <> 'discharged'` could not
// coexist with a RANGE partition (a partitioned table's unique constraints must include the partition key),
// and the volumes are trivial — so the active-row uniqueness wins and the table stays unpartitioned.
//
// Tenancy (M15-F05 / ADR-0010 / ARCH-011): patient-bearing → organization_id + provider_entity_id +
// location_id all NOT NULL, denormalized from the admission at bootstrap so the §4.3 compliance seams can
// aggregate per-PE/location without joining through M5/M6 schemas. RLS still pivots on organization_id ALONE.
//
// CROSS-MODULE FK POLICY (architecture wins): only organization_id / provider_entity_id / location_id (M1
// core) carry real FK constraints. patient_id (M5), admission_id (M6) and the membership references (M2)
// are LOGICAL uuid, app-validated. RLS + grants + the M4 write-audit trigger land in migration 0099.
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { disciplinePlanKind, disciplinePlanStatus } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const disciplineCarePlan = pgTable(
  "discipline_care_plan",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // logical FK → M5
    admissionId: uuid("admission_id").notNull(), // logical FK → M6
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),

    kind: disciplinePlanKind("kind").notNull(),
    status: disciplinePlanStatus("status").notNull().default("draft"),

    // aide_poc only (§2.3): both required before a version may reach `in_review`.
    aideMembershipId: uuid("aide_membership_id"), // logical FK → M2 membership
    supervisingRnMembershipId: uuid("supervising_rn_membership_id"), // logical FK → M2 membership

    // §7.1 — the 418.76(h) 14-day supervisory clock. The override may only TIGHTEN (1..14).
    nextSupervisoryDueAt: timestamp("next_supervisory_due_at", { withTimezone: true }),
    supervisoryCadenceDaysOverride: bigint("supervisory_cadence_days_override", { mode: "number" }),

    // §7.2 / §7.3 — the 5-day MSW + chaplain initial-assessment clock.
    initialAssessmentClockStartedAt: timestamp("initial_assessment_clock_started_at", {
      withTimezone: true,
    }),
    initialAssessmentSignedAt: timestamp("initial_assessment_signed_at", { withTimezone: true }),

    // §7.3 — the chaplain declination narrative (free text; audit-denylisted, never portal-surfaced).
    spiritualCareDeclined: text("spiritual_care_declined"),
    spiritualCareDeclinedAt: timestamp("spiritual_care_declined_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    dischargedAt: timestamp("discharged_at", { withTimezone: true }),
    version: bigint("version", { mode: "number" }).notNull().default(0), // §2.5 If-Match
  },
  (t) => ({
    // §3.3 — at most one non-discharged plan per (admission, kind).
    activeAdmissionKindUq: uniqueIndex("discipline_care_plan_admission_kind_active_uq")
      .on(t.organizationId, t.admissionId, t.kind)
      .where(sql`status <> 'discharged'`),
    patientKindIdx: index("discipline_care_plan_patient_kind_idx").on(
      t.organizationId,
      t.patientId,
      t.kind,
      t.status,
    ),
    // Hot path: the supervisory-overdue cron (§4.6).
    supervisoryDueIdx: index("discipline_care_plan_supervisory_due_idx")
      .on(t.organizationId, t.nextSupervisoryDueAt)
      .where(sql`kind = 'aide_poc' AND status = 'active'`),
    // Per-PE compliance rollups for DisciplineComplianceProvider (M15-F05).
    providerEntityIdx: index("discipline_care_plan_provider_entity_idx").on(
      t.organizationId,
      t.providerEntityId,
      t.locationId,
      t.kind,
    ),
    cadenceOverrideCheck: check(
      "discipline_care_plan_cadence_override_ck",
      sql`supervisory_cadence_days_override IS NULL
          OR (supervisory_cadence_days_override >= 1 AND supervisory_cadence_days_override <= 14)`,
    ),
  }),
);

export type DisciplineCarePlan = typeof disciplineCarePlan.$inferSelect;
export type NewDisciplineCarePlan = typeof disciplineCarePlan.$inferInsert;
