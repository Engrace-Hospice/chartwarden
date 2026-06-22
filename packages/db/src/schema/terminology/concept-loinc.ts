// @wardenx/db — `concept_loinc` (M38 Terminology §3.4). One of the four Phase-1
// per-system concept tables (§2.3). LOINC-specific columns are the six-axis model
// (component/property/time/system/scale/method) plus short_name; the axis index backs
// component+property lookups and the trigram index backs fuzzy display search. Composite
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

export const conceptLoinc = pgTable(
  "concept_loinc",
  {
    code: text("code").notNull(), // LOINC num
    display: text("display").notNull(), // long common name
    status: conceptStatus("status").notNull(),
    effectiveDate: date("effective_date").notNull(),
    endDate: date("end_date"),
    versionId: uuid("version_id")
      .notNull()
      .references(() => codeSystemVersions.id),
    // LOINC-specific (component/property/time/system/scale/method)
    component: text("component"),
    property: text("property"),
    time: text("time"),
    system: text("system"),
    scale: text("scale"),
    method: text("method"),
    shortName: text("short_name"),
    properties: jsonb("properties").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.code, t.versionId] }),
    codeIdx: index("loinc_code_idx").on(t.code),
    axisIdx: index("loinc_axis_idx").on(t.component, t.property),
    displayTrgmIdx: index("loinc_display_trgm_idx").using("gin", sql`display gin_trgm_ops`),
  }),
);

export type ConceptLoinc = typeof conceptLoinc.$inferSelect;
export type NewConceptLoinc = typeof conceptLoinc.$inferInsert;
