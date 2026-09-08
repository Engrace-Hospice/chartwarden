// @wardenx/db — `hope_spec_version` (M10 HOPE modernization Phase 1A). Platform reference table for
// immutable CMS HOPE Data Specification releases. Org-independent and non-PHI; later import jobs load
// the official CMS package rows against this version key.
import { date, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

export const hopeSpecVersions = pgTable(
  "hope_spec_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    itemSetVersion: text("item_set_version").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    sourceLabel: text("source_label").notNull(),
    sourceRelease: text("source_release"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeUnique: uniqueIndex("uniq_hope_spec_version_code").on(t.code),
    effectiveDate: index("idx_hope_spec_version_effective").on(t.effectiveFrom, t.effectiveTo),
  }),
);

export type HopeSpecVersion = typeof hopeSpecVersions.$inferSelect;
export type NewHopeSpecVersion = typeof hopeSpecVersions.$inferInsert;
