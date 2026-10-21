// @chartwarden/db — `code_system` (M38 Terminology §3.3). The platform-shared catalog of
// every code system M38 owns (one row per system: ICD-10-CM, SNOMED, LOINC, RxNorm, …).
// Platform-shared reference: NON_ORG_SCOPED, read-all via the §3.7 `USING (true)` policy;
// writes only via the `terminology_loader` role (SECURITY DEFINER load fns). 'cpt' never
// appears until D4 unlocks (§7.8) — enforced by the `code_system_id` enum, not data.
// Not PHI (canonical reference data), so the three-column rule does not apply.
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { codeSystemId } from "../../enums";

export const codeSystems = pgTable("code_system", {
  id: codeSystemId("id").primaryKey(),
  name: text("name").notNull(),
  licenseSource: text("license_source").notNull(), // 'public'|'umls'|'regenstrief'|'ama'
  sourceUri: text("source_uri"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type CodeSystem = typeof codeSystems.$inferSelect;
export type NewCodeSystem = typeof codeSystems.$inferInsert;
