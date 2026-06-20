// @wardenx/db — `value_set_expansion` (M38 Terminology §3.5). The materialized, hot read
// path: every (value_set, system, code) flattened with an as-of validity window, rebuilt
// at version load. `isMemberOf` is a single B-tree lookup against this table (M38-T04,
// §7.5); the as-of index serves freshness-correct expansion. Platform-shared reference
// (NON_ORG_SCOPED); writes only via `terminology_loader`. Not PHI.
import { date, index, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { codeSystemId } from "../../enums";
import { valueSets } from "./value-sets";

export const valueSetExpansion = pgTable(
  "value_set_expansion",
  {
    valueSetId: text("value_set_id")
      .notNull()
      .references(() => valueSets.id, { onDelete: "cascade" }),
    systemId: codeSystemId("system_id").notNull(),
    code: text("code").notNull(),
    asOfLower: date("as_of_lower").notNull(),
    asOfUpper: date("as_of_upper"),
    annotations: jsonb("annotations").notNull().default({}),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.valueSetId, t.systemId, t.code, t.asOfLower] }),
    membershipIdx: index("value_set_expansion_membership_idx").on(
      t.systemId,
      t.code,
      t.valueSetId,
    ),
    asOfIdx: index("value_set_expansion_asof_idx").on(t.valueSetId, t.asOfLower, t.asOfUpper),
  }),
);

export type ValueSetExpansion = typeof valueSetExpansion.$inferSelect;
export type NewValueSetExpansion = typeof valueSetExpansion.$inferInsert;
