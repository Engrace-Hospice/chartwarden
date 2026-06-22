// @wardenx/db — `patient_merge` (M5 §3.5, §2.4). The audit record of a patient merge: source folds
// into target, `patient.merged_into_id` redirects, and `merged_field_diff` records what changed for
// reversibility (`unmerged_at`). PHI-bearing → three-column tenancy rule. No self-merge.
import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { users } from "../users";
import { patients } from "./patients";

export const patientMerges = pgTable(
  "patient_merge",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    sourcePatientId: uuid("source_patient_id")
      .notNull()
      .references(() => patients.id),
    targetPatientId: uuid("target_patient_id")
      .notNull()
      .references(() => patients.id),
    reason: text("reason").notNull(),
    mergedFieldDiff: jsonb("merged_field_diff").notNull(),
    performedBy: uuid("performed_by").references(() => users.id, { onDelete: "set null" }),
    performedAt: timestamp("performed_at", { withTimezone: true }).notNull().defaultNow(),
    unmergedAt: timestamp("unmerged_at", { withTimezone: true }),
    unmergedBy: uuid("unmerged_by").references(() => users.id, { onDelete: "set null" }),
  },
  (t) => ({
    orgIdx: index("patient_merge_org_idx").on(t.organizationId),
    sourceIdx: index("patient_merge_source_idx").on(t.sourcePatientId),
    targetIdx: index("patient_merge_target_idx").on(t.targetPatientId),
    noSelfMerge: check("patient_merge_no_self", sql`${t.sourcePatientId} <> ${t.targetPatientId}`),
  }),
);

export type PatientMerge = typeof patientMerges.$inferSelect;
export type NewPatientMerge = typeof patientMerges.$inferInsert;
