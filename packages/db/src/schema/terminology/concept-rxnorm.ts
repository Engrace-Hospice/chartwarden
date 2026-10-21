// @chartwarden/db — `concept_rxnorm` (M38 Terminology §3.4). One of the four Phase-1
// per-system concept tables (§2.3). RxNorm-specific columns: tty (term type — IN/SCD/
// SBD/BN/…), ingredient_rxcui, and the associated-NDCs array at this version. Composite
// PK (code, version_id) keeps versions coexisting (§7.2). Platform-shared reference
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

export const conceptRxnorm = pgTable(
  "concept_rxnorm",
  {
    code: text("code").notNull(), // RxCUI
    display: text("display").notNull(),
    status: conceptStatus("status").notNull(),
    effectiveDate: date("effective_date").notNull(),
    endDate: date("end_date"),
    versionId: uuid("version_id")
      .notNull()
      .references(() => codeSystemVersions.id),
    // RxNorm-specific
    tty: text("tty").notNull(), // term type: 'IN','SCD','SBD','BN',...
    ingredientRxcui: text("ingredient_rxcui"),
    ndcs: text("ndcs").array(), // associated NDCs at this version
    properties: jsonb("properties").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.code, t.versionId] }),
    codeIdx: index("rxnorm_code_idx").on(t.code),
    ttyIdx: index("rxnorm_tty_idx").on(t.tty),
    ingredientIdx: index("rxnorm_ingredient_idx").on(t.ingredientRxcui),
    displayTrgmIdx: index("rxnorm_display_trgm_idx").using("gin", sql`display gin_trgm_ops`),
  }),
);

export type ConceptRxnorm = typeof conceptRxnorm.$inferSelect;
export type NewConceptRxnorm = typeof conceptRxnorm.$inferInsert;
