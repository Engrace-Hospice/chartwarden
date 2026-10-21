// @chartwarden/db — `value_set_member` (M38 Terminology §3.5). The authoring-time membership
// rows for a value set (one per (system, code) with its own effective range). The hot
// read path is the materialized `value_set_expansion`, rebuilt from these at version load
// (§7.5). Platform-shared reference (NON_ORG_SCOPED); writes only via `terminology_loader`.
// Not PHI.
import { date, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { codeSystemId } from "../../enums";
import { valueSets } from "./value-sets";

export const valueSetMembers = pgTable(
  "value_set_member",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    valueSetId: text("value_set_id")
      .notNull()
      .references(() => valueSets.id, { onDelete: "cascade" }),
    systemId: codeSystemId("system_id").notNull(),
    code: text("code").notNull(),
    memberEffective: date("member_effective").notNull(),
    memberEnd: date("member_end"),
    annotations: jsonb("annotations").notNull().default({}),
  },
  (t) => ({
    uniqueMember: uniqueIndex("value_set_member_unique").on(
      t.valueSetId,
      t.systemId,
      t.code,
      t.memberEffective,
    ),
    bySetIdx: index("value_set_member_by_set_idx").on(t.valueSetId),
  }),
);

export type ValueSetMember = typeof valueSetMembers.$inferSelect;
export type NewValueSetMember = typeof valueSetMembers.$inferInsert;
