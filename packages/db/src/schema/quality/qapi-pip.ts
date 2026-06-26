// @wardenx/db — `qapi_pip` (M30 §3.3; non-partitioned; retention class `compliance`).
// A QAPI Performance Improvement Project (PIP): charter + RCA + intervention/measurement/conclusion
// narrative, dual cosign (QAPI coordinator + medical director) gating closure (V-11 CHECK). Real
// intra-M30 FKs to qapi_program + qapi_project. ORG-SCOPED: organization_id NOT NULL (canonical
// app.org_id RLS). The RCA / intervention / conclusion narratives may name staff/patients →
// audit-denylisted (§3.6). document_id is an M22 back-ref (logical).
import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations } from "../organizations";
import { qapiProgram } from "./qapi-program";
import { qapiProject } from "./qapi-project";

export const m30QapiPipStatus = pgEnum("m30_qapi_pip_status", [
  "chartering",
  "root_cause_analysis",
  "intervention_in_progress",
  "measurement",
  "concluded",
  "suspended",
]);

export const qapiPip = pgTable(
  "qapi_pip",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    qapiProgramId: uuid("qapi_program_id")
      .notNull()
      .references(() => qapiProgram.id),
    linkedProjectId: uuid("linked_project_id").references(() => qapiProject.id),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    charterText: text("charter_text").notNull(),
    rootCauseAnalysisText: text("root_cause_analysis_text"), // DENYLISTED (§3.6)
    interventionPlanText: text("intervention_plan_text"), // DENYLISTED (§3.6)
    measurementPlanText: text("measurement_plan_text"),
    conclusionText: text("conclusion_text"), // DENYLISTED (§3.6)
    status: m30QapiPipStatus("status").notNull().default("chartering"),
    cosignQapiCoordinatorAt: timestamp("cosign_qapi_coordinator_at", { withTimezone: true }),
    cosignQapiCoordinatorMembershipId: uuid("cosign_qapi_coordinator_membership_id"),
    cosignMedicalDirectorAt: timestamp("cosign_medical_director_at", { withTimezone: true }),
    cosignMedicalDirectorMembershipId: uuid("cosign_medical_director_membership_id"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    suspendReason: text("suspend_reason"), // ≥60 chars if status=suspended
    documentId: uuid("document_id"), // populated by M22 back-ref
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    version: integer("version").notNull().default(1),
  },
  (t) => ({
    closureGuard: check(
      "chk_qapi_pip_closure_cosign", // V-11
      sql`(${t.closedAt} IS NULL) OR (${t.cosignQapiCoordinatorAt} IS NOT NULL AND ${t.cosignMedicalDirectorAt} IS NOT NULL)`,
    ),
  }),
);

export type QapiPip = typeof qapiPip.$inferSelect;
export type NewQapiPip = typeof qapiPip.$inferInsert;
