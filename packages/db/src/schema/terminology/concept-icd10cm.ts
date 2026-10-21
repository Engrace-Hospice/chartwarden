// @chartwarden/db — `concept_icd10cm` (M38 Terminology §3.4). One of the four Phase-1
// per-system concept tables (§2.3: one table per code system, NOT one polymorphic
// `concept` table). ICD-10-CM-specific columns (is_billable_leaf, chapter, parent_code)
// live as first-class columns; the §3.4 trigram index backs fuzzy display search.
// Composite PK (code, version_id) lets two versions of the same code coexist (§7.2).
// Platform-shared reference (NON_ORG_SCOPED); writes only via `terminology_loader`. Not PHI.
import { sql } from "drizzle-orm";
import {
  boolean,
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

export const conceptIcd10cm = pgTable(
  "concept_icd10cm",
  {
    code: text("code").notNull(),
    display: text("display").notNull(),
    status: conceptStatus("status").notNull(),
    effectiveDate: date("effective_date").notNull(),
    endDate: date("end_date"),
    versionId: uuid("version_id")
      .notNull()
      .references(() => codeSystemVersions.id),
    // ICD-10-specific
    isBillableLeaf: boolean("is_billable_leaf").notNull().default(false),
    chapter: text("chapter"),
    parentCode: text("parent_code"),
    properties: jsonb("properties").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.code, t.versionId] }),
    codeIdx: index("icd10cm_code_idx").on(t.code),
    asOfRangeIdx: index("icd10cm_asof_idx").on(t.code, t.effectiveDate, t.endDate),
    activeBillableIdx: index("icd10cm_active_billable_idx")
      .on(t.status)
      .where(sql`status = 'active' AND is_billable_leaf = true`),
    parentIdx: index("icd10cm_parent_idx").on(t.parentCode),
    displayTrgmIdx: index("icd10cm_display_trgm_idx").using("gin", sql`display gin_trgm_ops`),
  }),
);

export type ConceptIcd10cm = typeof conceptIcd10cm.$inferSelect;
export type NewConceptIcd10cm = typeof conceptIcd10cm.$inferInsert;
