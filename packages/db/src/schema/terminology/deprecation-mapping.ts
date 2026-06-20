// @wardenx/db — `deprecation_mapping` (M38 Terminology §3.6). The successor record for a
// deprecated code: which code(s) replace it, the relationship kind (equivalent/broader/
// narrower/none/see_other), and remediation guidance. Drives annual deprecation
// remediation — the post-load tenant scan that finds records still using deprecated codes
// (M38-T07, §7.3). Platform-shared reference (NON_ORG_SCOPED); writes only via
// `terminology_loader`. Not PHI.
import { sql } from "drizzle-orm";
import { date, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { codeSystemId, deprecationMappingKind } from "../../enums";
import { codeSystemVersions } from "./code-system-versions";

export const deprecationMapping = pgTable(
  "deprecation_mapping",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    systemId: codeSystemId("system_id").notNull(),
    deprecatedCode: text("deprecated_code").notNull(),
    deprecationEffective: date("deprecation_effective").notNull(),
    successorCodes: text("successor_codes")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    mappingKind: deprecationMappingKind("mapping_kind").notNull(),
    guidance: text("guidance"),
    createdInVersionId: uuid("created_in_version_id")
      .notNull()
      .references(() => codeSystemVersions.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bySystemCodeIdx: uniqueIndex("deprecation_mapping_unique").on(
      t.systemId,
      t.deprecatedCode,
      t.deprecationEffective,
    ),
  }),
);

export type DeprecationMapping = typeof deprecationMapping.$inferSelect;
export type NewDeprecationMapping = typeof deprecationMapping.$inferInsert;
