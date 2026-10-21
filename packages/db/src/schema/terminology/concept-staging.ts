// @chartwarden/db — `concept_staging` (M38 §2.4.2 `loading → staged`, GAP-108, migration 0364). Parsed-but-not-active
// rows of a version, kept OUT of the concept tables so clinical lookups can never see a half-loaded version. Holds
// `kind = 'concept'` rows and `kind = 'deprecation'` rows (successor detail for codes the version retires).
// Loader-only (chartwarden_app has no grant); emptied on activation or failure. Platform-shared (NON_ORG_SCOPED). Not PHI.
import { date, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { conceptStatus } from "../../enums";
import { codeSystemVersions } from "./code-system-versions";

export const conceptStaging = pgTable(
  "concept_staging",
  {
    versionId: uuid("version_id")
      .notNull()
      .references(() => codeSystemVersions.id),
    kind: text("kind").notNull(), // 'concept' | 'deprecation'
    code: text("code").notNull(),
    display: text("display").notNull(),
    status: conceptStatus("status").notNull().default("active"),
    effectiveDate: date("effective_date"),
    endDate: date("end_date"),
    properties: jsonb("properties").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.versionId, t.kind, t.code] }),
  }),
);

export type ConceptStagingRow = typeof conceptStaging.$inferSelect;
