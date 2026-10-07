// @wardenx/db — `assessment_reassessment_due` (M9 §4.8 `reassessment-due-scan`, GAP-181). One row per
// (organization, patient, scale_type): the next reassessment due instant derived from the last capture and
// the effective cadence (CoP 42 CFR 418.54(d) floor, tenant-tightenable only). Written solely by the daily
// cadence cron (system actor); read by the chart banner and the M36 alert path. Overdue is a SOFT state — it
// never blocks recording. PHI-adjacent → the three-column tenancy rule. RLS + grants + the M4 write-audit
// trigger land in migration 0481.
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { scaleType } from "../../enums";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";

export const assessmentReassessmentDue = pgTable(
  "assessment_reassessment_due",
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
    scaleType: scaleType("scale_type").notNull(),
    lastCapturedAt: timestamp("last_captured_at", { withTimezone: true }).notNull(),
    cadenceDays: integer("cadence_days").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    /** `open` (not yet due) | `overdue` | `closed` (the patient is no longer on an active admission). */
    status: text("status").notNull().default("open"),
    overdueSince: timestamp("overdue_since", { withTimezone: true }),
    alertedAt: timestamp("alerted_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientScaleUq: uniqueIndex("assessment_reassessment_due_patient_scale_uq").on(
      t.organizationId,
      t.patientId,
      t.scaleType,
    ),
    statusDueIdx: index("assessment_reassessment_due_status_due_idx").on(
      t.organizationId,
      t.status,
      t.dueAt,
    ),
  }),
);

export type AssessmentReassessmentDue = typeof assessmentReassessmentDue.$inferSelect;
export type NewAssessmentReassessmentDue = typeof assessmentReassessmentDue.$inferInsert;
