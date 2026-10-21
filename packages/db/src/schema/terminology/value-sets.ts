// @chartwarden/db — `value_set` (M38 Terminology §3.5). A named, platform-curated set of
// concepts (e.g. a HQRP measure's allowed codes) keyed by a stable slug. Members live in
// `value_set_member`; the materialized read path is `value_set_expansion`; tenants may
// add-only via `value_set_tenant_extension` (§7.6). Platform-shared reference
// (NON_ORG_SCOPED); writes only via `terminology_loader`. Not PHI.
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { valueSetScope } from "../../enums";

export const valueSets = pgTable("value_set", {
  id: text("id").primaryKey(), // stable slug
  name: text("name").notNull(),
  description: text("description"),
  scope: valueSetScope("scope").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ValueSet = typeof valueSets.$inferSelect;
export type NewValueSet = typeof valueSets.$inferInsert;
