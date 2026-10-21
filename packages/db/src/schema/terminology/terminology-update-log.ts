// @chartwarden/db — `terminology_update_log` (M38 Terminology §3.6). Append-only ledger of
// every terminology change (version load, deprecation, expansion rebuild, embedding,
// tenant-extension add/remove) with concept counts and a summary blob. Kept beyond the M4
// audit retention class — it is the operational record of what the loader did. Platform-
// shared reference (NON_ORG_SCOPED); writes only via `terminology_loader`. Not PHI.
import { index, integer, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { codeSystemId, terminologyUpdateAction } from "../../enums";
import { codeSystemVersions } from "./code-system-versions";

export const terminologyUpdateLog = pgTable(
  "terminology_update_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    systemId: codeSystemId("system_id").notNull(),
    versionId: uuid("version_id").references(() => codeSystemVersions.id),
    action: terminologyUpdateAction("action").notNull(),
    conceptCount: integer("concept_count").notNull().default(0),
    newCodes: integer("new_codes").notNull().default(0),
    retiredCodes: integer("retired_codes").notNull().default(0),
    affectedValueSets: integer("affected_value_sets").notNull().default(0),
    summary: jsonb("summary").notNull().default({}),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bySystemAtIdx: index("terminology_update_log_system_at_idx").on(t.systemId, t.at),
  }),
);

export type TerminologyUpdateLog = typeof terminologyUpdateLog.$inferSelect;
export type NewTerminologyUpdateLog = typeof terminologyUpdateLog.$inferInsert;
