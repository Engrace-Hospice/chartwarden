// @wardenx/db — `hope_spec_item` (M10 HOPE modernization Phase 1A). Versioned CMS item master rows,
// shaped to ingest the official itm_mstr source without annual schema churn.
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { hopeSpecItemKind } from "../../enums";
import { hopeSpecVersions } from "./hope-spec-versions";

export const hopeSpecItems = pgTable(
  "hope_spec_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    specVersionId: uuid("spec_version_id")
      .notNull()
      .references(() => hopeSpecVersions.id, { onDelete: "restrict" }),
    cmsItemMasterKey: text("cms_item_master_key").notNull(),
    itemCode: text("item_code").notNull(),
    databaseItemCode: text("database_item_code"),
    shortLabel: text("short_label").notNull(),
    sectionLabel: text("section_label").notNull(),
    itemSortOrder: integer("item_sort_order").notNull(),
    sectionSortOrder: integer("section_sort_order").notNull(),
    groupCode: text("group_code"),
    loincId: text("loinc_id"),
    cmsItemTypeCode: text("cms_item_type_code").notNull(),
    kind: hopeSpecItemKind("kind").notNull(),
    fixedRecordSortOrder: integer("fixed_record_sort_order"),
    fixedRecordStartByte: integer("fixed_record_start_byte"),
    fixedRecordEndByte: integer("fixed_record_end_byte"),
    fixedRecordLength: integer("fixed_record_length"),
    versionNotes: text("version_notes"),
    sourceMetadata: jsonb("source_metadata").notNull().default({}),
  },
  (t) => ({
    versionItemCodeUnique: uniqueIndex("uniq_hope_spec_item_version_code").on(
      t.specVersionId,
      t.itemCode,
    ),
    byVersionSort: index("idx_hope_spec_item_version_sort").on(
      t.specVersionId,
      t.sectionSortOrder,
      t.itemSortOrder,
    ),
    byCmsMasterKey: index("idx_hope_spec_item_cms_master_key").on(t.cmsItemMasterKey),
  }),
);

export type HopeSpecItem = typeof hopeSpecItems.$inferSelect;
export type NewHopeSpecItem = typeof hopeSpecItems.$inferInsert;
