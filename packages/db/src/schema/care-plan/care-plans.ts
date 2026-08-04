// @wardenx/db — `care_plan` (M7 §3.3). The IPOC root: one care plan per active hospice episode.
// PHI-bearing → the three-column tenancy rule; provider_entity_id + location_id are NOT NULL (a care
// plan is a patient/admission-scoped clinical record, always sited — denormalized from the admission
// at bootstrap so IDG/overdue dashboards run location-/PE-scoped without joining M5/M6). Cross-module
// refs (M5 patient, M6 admission) are plain uuid app-validated, NOT cross-module FKs (M6 precedent;
// M7 may not read M5/M6 schema directly). activeVersionId is a soft self-ref to care_plan_version
// (no FK — supersession is via the version status enum). RLS + the M4 write-audit trigger land in
// migration 0029 (M7-T02, §3.4–3.6).
import { sql } from "drizzle-orm";
import { boolean, index, integer, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { carePlanStatus } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const carePlans = pgTable(
  "care_plan",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // provider_entity_id / location_id are denormalized siting; nullable since the bootstrap route
    // carries only patient + admission and the admission itself may not be sited yet (mig 0127, M6 0123).
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    admissionId: uuid("admission_id").notNull(), // M6 admission (app-validated; no cross-module FK)
    status: carePlanStatus("status").notNull().default("draft"),
    version: integer("version").notNull().default(1), // §7.7 optimistic concurrency (mig 0127)
    initialDueAt: timestamp("initial_due_at", { withTimezone: true }).notNull(),
    initialSignedAt: timestamp("initial_signed_at", { withTimezone: true }),
    nextReviewDueAt: timestamp("next_review_due_at", { withTimezone: true }),
    // TASK-040D (mig 0161) — the §7.1/§7.2 gate-scan columns `jobs/index.ts`'s pure scan functions read.
    /** Echoed into `m7.care_plan.initial_overdue` (§7.1); stamped at bootstrap, NULL on pre-migration rows. */
    admissionActivatedAt: timestamp("admission_activated_at", { withTimezone: true }),
    /** Fires once per `initialDueAt` deadline (§7.1) — never re-arms (a signed plan never re-warns). */
    initialWarningEmitted: boolean("initial_warning_emitted").notNull().default(false),
    /** Fires once per `nextReviewDueAt` deadline (§7.2 T+13); re-arms whenever a sign recomputes the due date. */
    reviewDueEmitted: boolean("review_due_emitted").notNull().default(false),
    /** Fires once per `nextReviewDueAt` deadline (§7.2 T+15); re-arms whenever a sign recomputes the due date. */
    reviewOverdueEmitted: boolean("review_overdue_emitted").notNull().default(false),
    activeVersionId: uuid("active_version_id"), // soft self-ref to care_plan_version (no FK)
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgPatientIdx: index("care_plan_org_patient_idx").on(t.organizationId, t.patientId),
    onePerAdmission: uniqueIndex("care_plan_one_per_admission_uq")
      .on(t.organizationId, t.admissionId)
      .where(sql`status <> 'discharged'`),
    dueIdx: index("care_plan_next_review_due_idx").on(t.nextReviewDueAt),
    initialDueIdx: index("care_plan_initial_due_idx").on(t.initialDueAt),
  }),
);

export type CarePlan = typeof carePlans.$inferSelect;
export type NewCarePlan = typeof carePlans.$inferInsert;
