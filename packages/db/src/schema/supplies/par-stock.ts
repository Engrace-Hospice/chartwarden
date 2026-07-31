// @wardenx/db — `par_stock` (M21 §3.1.6). D5's supply-hub inventory posture: one row per
// (org, location, SKU) recording what is on the shelf and the three thresholds the nightly `par-monitor`
// cron compares against. NOT patient data — this is agency inventory at a Location, which is why the
// `M21ParThresholdPayload` in @wardenx/types carries no patientId at all.
//
// §3.0 / M21-F04: the §3.1 `reorder_point` / `reorder_quantity` / `min_safety_stock` model is normative and
// the §3.2 draft's `parMinimum` / `parTarget` / stored `currentSeverity` fork is dropped. Severity is
// DERIVED (`ok` / `low` at ≤ reorder_point / `critical` at ≤ min_safety_stock) in `@wardenx/supplies`, not
// stored: a stored severity is a second source of truth that goes stale the moment a threshold is edited,
// and the screen that reads it would then show a green shelf that is actually empty.
//
// TENANCY (ARCH-011 / ADR-0010): organization_id + provider_entity_id + location_id, all NOT NULL. The PE is
// present because `M21ParThresholdPayload` (locked in M21-T01) publishes `providerEntityId` on every
// threshold alert — M27's cost-center rollup and M30's stockout-rate measure are both per-CCN, and joining
// back through M2's Location to find the CCN at alert time is exactly the cross-module read the seam rules
// forbid. Canonical app.org_id RLS.
//
// D11 XOR: a par row points at EITHER a platform `supply_item` OR a `tenant_supply_item_extension`, never
// both and never neither. Two PARTIAL unique indexes rather than the spec's four-column UNIQUE, because a
// plain UNIQUE containing a NULL column does not dedupe in PostgreSQL — `(org, loc, sku, NULL)` twice is
// two legal rows, which is precisely the duplicate the constraint was written to prevent.
//
// CROSS-MODULE FK POLICY: organization_id / provider_entity_id / location_id (M1 core) and both intra-M21
// SKU parents carry real FKs. `last_par_reviewed_by_membership_id` is a logical M2 uuid.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { locations } from "../locations";
import { organizations } from "../organizations";
import { providerEntities } from "../provider-entities";
import { supplyItem } from "./supply-items";
import { tenantSupplyItemExtension } from "./tenant-supply-item-extensions";

export const parStock = pgTable(
  "par_stock",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    providerEntityId: uuid("provider_entity_id")
      .notNull()
      .references(() => providerEntities.id, { onDelete: "restrict" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),

    skuId: uuid("sku_id").references(() => supplyItem.id, { onDelete: "restrict" }),
    tenantSkuExtensionId: uuid("tenant_sku_extension_id").references(
      () => tenantSupplyItemExtension.id,
      { onDelete: "restrict" },
    ),

    currentQuantity: numeric("current_quantity").notNull().default("0"),
    unit: text("unit").notNull(),
    /** At or below → `m21.par.below_threshold`. */
    reorderPoint: numeric("reorder_point").notNull().default("0"),
    /** How much to order when it trips — not a threshold, the replenishment size. */
    reorderQuantity: numeric("reorder_quantity").notNull().default("0"),
    /** At or below → `m21.par.stockout_imminent`. */
    minSafetyStock: numeric("min_safety_stock").notNull().default("0"),

    isActive: boolean("is_active").notNull().default(true),
    lastParReviewAt: timestamp("last_par_review_at", { withTimezone: true }),
    lastParReviewedByMembershipId: uuid("last_par_reviewed_by_membership_id"), // logical FK → M2
    /** Free-text hub note — D13 audit-denylisted. */
    reorderNotes: text("reorder_notes"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // See the header: partial uniques, because UNIQUE over a nullable column does not dedupe.
    platformSkuUniq: uniqueIndex("m21_par_stock_platform_sku_uniq")
      .on(t.organizationId, t.locationId, t.skuId)
      .where(sql`sku_id IS NOT NULL`),
    tenantSkuUniq: uniqueIndex("m21_par_stock_tenant_sku_uniq")
      .on(t.organizationId, t.locationId, t.tenantSkuExtensionId)
      .where(sql`tenant_sku_extension_id IS NOT NULL`),

    orgLocationActiveIdx: index("par_stock_org_location_active_idx")
      .on(t.organizationId, t.locationId)
      .where(sql`is_active = true`),
    belowReorderIdx: index("par_stock_below_reorder_idx")
      .on(t.organizationId, t.locationId)
      .where(sql`is_active = true AND current_quantity <= reorder_point`),

    exactlyOneSku: check(
      "m21_par_stock_sku_xor",
      sql`(sku_id IS NOT NULL) <> (tenant_sku_extension_id IS NOT NULL)`,
    ),
    quantityNonNegative: check("m21_par_stock_qty_non_negative", sql`current_quantity >= 0`),
    // The safety stock is the floor UNDER the reorder point; inverted thresholds would make the
    // `critical` band unreachable and the shelf would empty without ever escalating.
    thresholdsOrdered: check(
      "m21_par_stock_thresholds_ordered",
      sql`min_safety_stock >= 0 AND reorder_point >= min_safety_stock AND reorder_quantity >= 0`,
    ),
  }),
);

export type ParStockRow = typeof parStock.$inferSelect;
export type NewParStockRow = typeof parStock.$inferInsert;
