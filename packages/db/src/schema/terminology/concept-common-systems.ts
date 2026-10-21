// @chartwarden/db — the seven Phase-1 per-system concept tables that carry only the COMMON concept shape (§2.3):
// ICD-10-PCS, NDC, HCPCS, CVX, UB-04 revenue, CARC, RARC. (ICD-10-CM / SNOMED / LOINC / RxNorm have bespoke
// columns and their own files.) One table per system, never one polymorphic table — the system-specific detail
// (NDC labeller, HCPCS short description, CARC group code …) rides `properties` until a hot-path column is earned.
// Created by migration 0364 (GAP-108); platform-shared reference (NON_ORG_SCOPED); writes only via the
// `terminology_loader` activation function. Not PHI.
import { sql } from "drizzle-orm";
import {
  date,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { conceptStatus } from "../../enums";
import { codeSystemVersions } from "./code-system-versions";

function commonConceptTable<const Name extends string>(name: Name, short: string) {
  return pgTable(
    name,
    {
      code: text("code").notNull(),
      display: text("display").notNull(),
      status: conceptStatus("status").notNull(),
      effectiveDate: date("effective_date").notNull(),
      endDate: date("end_date"),
      versionId: uuid("version_id")
        .notNull()
        .references(() => codeSystemVersions.id),
      properties: jsonb("properties").notNull().default({}),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => ({
      pk: primaryKey({ columns: [t.code, t.versionId], name: `${name}_code_version_id_pk` }),
      codeIdx: index(`${short}_code_idx`).on(t.code),
      asOfIdx: index(`${short}_asof_idx`).on(t.code, t.effectiveDate, t.endDate),
      displayTrgmIdx: index(`${short}_display_trgm_idx`).using("gin", sql`display gin_trgm_ops`),
    }),
  );
}

export const conceptIcd10pcs = commonConceptTable("concept_icd10pcs", "icd10pcs");
export const conceptNdc = commonConceptTable("concept_ndc", "ndc");
export const conceptHcpcs = commonConceptTable("concept_hcpcs", "hcpcs");
export const conceptCvx = commonConceptTable("concept_cvx", "cvx");
export const conceptRevenue = commonConceptTable("concept_revenue", "revenue");
export const conceptCarc = commonConceptTable("concept_carc", "carc");
export const conceptRarc = commonConceptTable("concept_rarc", "rarc");

export type CommonConceptRow = typeof conceptNdc.$inferSelect;
