// @wardenx/db — `symptom_follow_up_visit` (M10 §3.3, D4). One row per J2051-triggered SFV: the
// open→completed/overdue/missed lifecycle (§2.2.3), the visit_date+2-calendar-day due window (ADR-0018
// D1), and the alert cadence. PHI-bearing → the three-column tenancy rule (PE/location denormalized
// from the triggering assessment, §3.3 tenancy note). RLS keys on app.org_id alone. Cross-module refs
// (M5 patient, M6 admission) are plain uuid app-validated; the triggering/completing hope_assessment
// links are plain uuid (the parent is partitioned — a composite-PK FK is impractical; integrity is
// enforced in the service layer). One SFV per triggering assessment (D4) is a unique index. RLS +
// grants + the M4 write-audit trigger (alert_cadence denylisted, §8.1) land in the RLS migration.
import { index, jsonb, pgTable, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { hopeSfvStatus } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const symptomFollowUpVisits = pgTable(
  "symptom_follow_up_visit",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    // NOT NULL relaxed in mig 0130 (M10L): denormalized siting backfills from the triggering assessment.
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),

    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    admissionId: uuid("admission_id").notNull(), // M6 admission (logical; not enforced cross-module)
    triggeringAssessmentId: uuid("triggering_assessment_id").notNull(), // M10 hope_assessment (logical; parent partitioned)
    completingAssessmentId: uuid("completing_assessment_id"), // M10 hope_assessment (logical; nullable until completed)

    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(), // visit_date + 2 calendar days (ADR-0018 D1)
    status: hopeSfvStatus("status").notNull().default("open"),
    alertCadence: jsonb("alert_cadence").notNull(), // AlertCadence (§3.3); free-text denylisted from audit
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byPatientOpen: index("idx_sfv_patient_open").on(t.patientId, t.status, t.dueAt),
    byOrgDueAt: index("idx_sfv_org_due_at").on(t.organizationId, t.status, t.dueAt),
    // One SFV per triggering assessment (D4).
    uniqueTriggeringAssessment: uniqueIndex("uniq_sfv_per_triggering_assessment").on(
      t.triggeringAssessmentId,
    ),
  }),
);

export type SymptomFollowUpVisit = typeof symptomFollowUpVisits.$inferSelect;
export type NewSymptomFollowUpVisit = typeof symptomFollowUpVisits.$inferInsert;
