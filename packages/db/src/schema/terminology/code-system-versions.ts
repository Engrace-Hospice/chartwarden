// @chartwarden/db — `code_system_version` (M38 Terminology §3.3). One row per loaded version
// of a code system (e.g. ICD-10-CM '2024', SNOMED '2024-09-AA'). Carries the effective
// range that the as-of-date resolution engine (M38-T04, §7.1) keys on: two versions of a
// system coexist; the older is never deleted (§7.2). Platform-shared reference
// (NON_ORG_SCOPED); writes only via the `terminology_loader` role. Not PHI.
import { sql } from "drizzle-orm";
import { date, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { codeSystemId, versionLoadStatus } from "../../enums";
import { users } from "../users";
import { codeSystems } from "./code-systems";

export const codeSystemVersions = pgTable(
  "code_system_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    codeSystemId: codeSystemId("code_system_id")
      .notNull()
      .references(() => codeSystems.id, { onDelete: "restrict" }),
    version: text("version").notNull(), // '2024' or '2024-09-AA' (snomed)
    releasedOn: date("released_on").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"), // nullable; null = current
    sourceFileRef: text("source_file_ref").notNull(), // MinIO object id
    checksum: text("checksum").notNull(), // sha256 of source
    status: versionLoadStatus("status").notNull().default("loading"),
    loadedAt: timestamp("loaded_at", { withTimezone: true }).notNull().defaultNow(),
    loadedBy: uuid("loaded_by").references(() => users.id),
  },
  (t) => ({
    uniquePerSystem: uniqueIndex("code_system_version_unique").on(t.codeSystemId, t.version),
    currentIdx: index("code_system_version_current_idx")
      .on(t.codeSystemId)
      .where(sql`status = 'active' AND effective_to IS NULL`),
    effectiveRangeIdx: index("code_system_version_effective_idx").on(
      t.codeSystemId,
      t.effectiveFrom,
      t.effectiveTo,
    ),
  }),
);

export type CodeSystemVersion = typeof codeSystemVersions.$inferSelect;
export type NewCodeSystemVersion = typeof codeSystemVersions.$inferInsert;
