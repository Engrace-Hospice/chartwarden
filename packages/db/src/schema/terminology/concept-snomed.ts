// @wardenx/db — `concept_snomed` (M38 Terminology §3.4). SNOMED CT US Edition
// (~360k active concepts); one of the four Phase-1 per-system concept tables (§2.3).
// SNOMED-specific columns: fully_specified_name, semantic_tag, and the hierarchy_path
// ancestor-SCTID array (GIN-indexed for subsumption queries). Composite PK
// (code, version_id) keeps versions coexisting (§7.2). Platform-shared reference
// (NON_ORG_SCOPED); writes only via `terminology_loader`. Not PHI.
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

export const conceptSnomed = pgTable(
  "concept_snomed",
  {
    code: text("code").notNull(), // SCTID
    display: text("display").notNull(), // preferred FSN/synonym
    status: conceptStatus("status").notNull(),
    effectiveDate: date("effective_date").notNull(),
    endDate: date("end_date"),
    versionId: uuid("version_id")
      .notNull()
      .references(() => codeSystemVersions.id),
    // SNOMED-specific
    fullySpecifiedName: text("fully_specified_name").notNull(),
    semanticTag: text("semantic_tag"), // 'disorder','finding','procedure',...
    hierarchyPath: text("hierarchy_path").array(), // ancestor SCTIDs
    properties: jsonb("properties").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.code, t.versionId] }),
    codeIdx: index("snomed_code_idx").on(t.code),
    semanticTagIdx: index("snomed_semantic_tag_idx").on(t.semanticTag),
    hierarchyIdx: index("snomed_hierarchy_idx").using("gin", sql`hierarchy_path`),
    displayTrgmIdx: index("snomed_display_trgm_idx").using("gin", sql`display gin_trgm_ops`),
  }),
);

export type ConceptSnomed = typeof conceptSnomed.$inferSelect;
export type NewConceptSnomed = typeof conceptSnomed.$inferInsert;
