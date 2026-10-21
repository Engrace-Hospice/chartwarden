// @chartwarden/db — `hope_timepoint_schedule` (M10 §3.3). One row per HOPE timepoint window
// (Admission / HUV1 / HUV2 / Discharge — and SFV rows are distinct): the open→completed/expired/skipped
// lifecycle (§2.2.1), the [window_opens_at, window_closes_at, late_deadline_at] schedule, and the
// tenant alert cadence. PHI-bearing → the three-column tenancy rule (organization_id +
// provider_entity_id + location_id all NOT NULL, denormalized from the admission, §3.3 tenancy note) so
// the per-CCN batch assembler and the location-scoped overdue dashboard run without joining M6. RLS
// keys on app.org_id alone. Cross-module refs (M5 patient, M6 admission) are plain uuid app-validated,
// NOT cross-module FKs (ADR-0011, M10-F01); completed_by_assessment_id is a plain uuid (the
// hope_assessment parent is partitioned — a composite-PK FK is impractical). RLS + grants + the M4
// write-audit trigger (alert_cadence denylisted, §8.1) land in the RLS migration.
import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { hopeRfaKind, hopeScheduleGeneratedBy, hopeScheduleStatus } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const hopeTimepointSchedules = pgTable(
  "hope_timepoint_schedule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),

    patientId: uuid("patient_id").notNull(), // M5 patient (app-validated; no cross-module FK)
    admissionId: uuid("admission_id").notNull(), // M6 admission (logical; not enforced cross-module)

    rfaKind: hopeRfaKind("rfa_kind").notNull(),
    windowOpensAt: timestamp("window_opens_at", { withTimezone: true }).notNull(),
    windowClosesAt: timestamp("window_closes_at", { withTimezone: true }).notNull(),
    lateDeadlineAt: timestamp("late_deadline_at", { withTimezone: true }).notNull(),
    alertCadence: jsonb("alert_cadence").notNull(), // AlertCadence (§3.3); free-text denylisted from audit
    status: hopeScheduleStatus("status").notNull().default("open"),
    completedByAssessmentId: uuid("completed_by_assessment_id"), // M10 hope_assessment (logical; parent is partitioned)
    generatedBy: hopeScheduleGeneratedBy("generated_by").notNull(),
    skipReasonCode: text("skip_reason_code"), // required when status='skipped'
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // "what's open for this patient" and "what's open org-wide" (the window worklist).
    byPatientOpen: index("idx_hope_sched_by_patient_open").on(
      t.patientId,
      t.status,
      t.windowOpensAt,
    ),
    byOrgWindow: index("idx_hope_sched_by_org_window").on(
      t.organizationId,
      t.status,
      t.windowClosesAt,
    ),
    // One open base-RFA schedule per (admission, rfa_kind); SFVs (RFA 04) are distinct rows.
    uniqueOpenAdmissionRfa: uniqueIndex("uniq_hope_sched_admission_rfa_open")
      .on(t.admissionId, t.rfaKind)
      .where(sql`status = 'open' AND rfa_kind != '04_sfv'`),
  }),
);

export type HopeTimepointSchedule = typeof hopeTimepointSchedules.$inferSelect;
export type NewHopeTimepointSchedule = typeof hopeTimepointSchedules.$inferInsert;
