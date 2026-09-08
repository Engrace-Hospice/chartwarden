// @wardenx/db — `hope_spec_item_isc` (M10 HOPE modernization Phase 1A). Normalized ISC activation
// matrix for CMS HOPE items; one row per item and internal item-set code.
import { boolean, index, pgTable, primaryKey, uuid } from "drizzle-orm/pg-core";
import { hopeIsc } from "../../enums";
import { hopeSpecItems } from "./hope-spec-items";

export const hopeSpecItemIsc = pgTable(
  "hope_spec_item_isc",
  {
    specItemId: uuid("spec_item_id")
      .notNull()
      .references(() => hopeSpecItems.id, { onDelete: "restrict" }),
    isc: hopeIsc("isc").notNull(),
    active: boolean("active").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.specItemId, t.isc] }),
    byIscActive: index("idx_hope_spec_item_isc_active").on(t.isc, t.active),
  }),
);

export type HopeSpecItemIsc = typeof hopeSpecItemIsc.$inferSelect;
export type NewHopeSpecItemIsc = typeof hopeSpecItemIsc.$inferInsert;
