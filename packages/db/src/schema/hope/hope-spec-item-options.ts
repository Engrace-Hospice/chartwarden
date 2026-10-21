// @chartwarden/db — `hope_spec_item_option` (M10 HOPE modernization Phase 1A). Official allowed coded
// values from CMS itm_val. `value_code` is text because CMS codes are not guaranteed numeric.
import { index, integer, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { hopeSpecItems } from "./hope-spec-items";

export const hopeSpecItemOptions = pgTable(
  "hope_spec_item_option",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    specItemId: uuid("spec_item_id")
      .notNull()
      .references(() => hopeSpecItems.id, { onDelete: "restrict" }),
    cmsItemValueKey: text("cms_item_value_key").notNull(),
    sortOrder: integer("sort_order").notNull(),
    valueCode: text("value_code").notNull(),
    label: text("label").notNull(),
    loincId: text("loinc_id"),
  },
  (t) => ({
    itemValueUnique: uniqueIndex("uniq_hope_spec_item_option_value").on(t.specItemId, t.valueCode),
    byItemSort: index("idx_hope_spec_item_option_sort").on(t.specItemId, t.sortOrder),
  }),
);

export type HopeSpecItemOption = typeof hopeSpecItemOptions.$inferSelect;
export type NewHopeSpecItemOption = typeof hopeSpecItemOptions.$inferInsert;
