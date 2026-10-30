// @chartwarden/db — `patient_code_status` (M5; ADR-0104, migration 1294). The clinician-set code status history:
// one append-only row per decision; the current status is the newest row that is not entered-in-error. PHI-bearing →
// three-column tenancy, ENABLE+FORCE RLS, M4 write-audit trigger (`reason`, `entered_in_error_reason` denylisted).
// The app role may only INSERT and mark a row entered-in-error (column-level UPDATE grant): a recorded value is never
// edited and nothing deletes a row. `source_document_id` is a plain uuid (M22 owns `document`).
import type { PatientCodeStatus } from "@chartwarden/types";
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { patients } from "./patients";

export const patientCodeStatuses = pgTable(
  "patient_code_status",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id").references(() => providerEntities.id, {
      onDelete: "restrict",
    }),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "restrict" }),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "restrict" }),
    codeStatus: text("code_status").$type<PatientCodeStatus>().notNull(),
    reason: text("reason").notNull(), // DENYLISTED
    sourceDocumentId: uuid("source_document_id"),
    recordedByMembershipId: uuid("recorded_by_membership_id").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    enteredInErrorByMembershipId: uuid("entered_in_error_by_membership_id"),
    enteredInErrorAt: timestamp("entered_in_error_at", { withTimezone: true }),
    enteredInErrorReason: text("entered_in_error_reason"), // DENYLISTED
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    patientIdx: index("patient_code_status_patient_idx").on(
      t.organizationId,
      t.patientId,
      t.recordedAt.desc(),
    ),
    valueChk: check(
      "patient_code_status_value_chk",
      sql`code_status IN ('full_code', 'dnr', 'dnr_dni', 'comfort_measures_only')`,
    ),
  }),
);

export type PatientCodeStatusRow = typeof patientCodeStatuses.$inferSelect;
export type NewPatientCodeStatusRow = typeof patientCodeStatuses.$inferInsert;
