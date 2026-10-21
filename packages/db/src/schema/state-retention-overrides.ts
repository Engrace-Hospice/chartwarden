// @chartwarden/db — `state_retention_override` (M4 Audit §3.5, §3.6). Platform-reference table:
// per-state, per-data-class retention specs (with citation) that override the federal floor.
// NON_ORG_SCOPED (no organization_id) — read-all reference data; writes only via the platform
// role (check-tenancy allowlist). Composite PK on (state_code, data_class).
import { pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const stateRetentionOverrides = pgTable(
  "state_retention_override",
  {
    stateCode: text("state_code").notNull(),
    dataClass: text("data_class").notNull(),
    retentionSpec: text("retention_spec").notNull(), // '7y' | 'until_age_21+7' | ...
    citation: text("citation").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.stateCode, t.dataClass] }),
  }),
);

export type StateRetentionOverride = typeof stateRetentionOverrides.$inferSelect;
export type NewStateRetentionOverride = typeof stateRetentionOverrides.$inferInsert;
