// @chartwarden/db — `tenant_supply_item_extension` (M21 §3.1.3). D11's TENANT half of the canonical-plus-overlay
// pair: the non-billable, agency-local items that will never carry a HCPCS code (the hub's own wound-care
// kits, a locally-branded brief, a custom oxygen-tubing bundle). Platform SKUs live in `supply_item`.
//
// WHY IT IS A SEPARATE TABLE rather than org-scoped rows inside `supply_item`: the platform catalog is
// read-only to tenants and rewritten wholesale by the annual HCPCS loader. Mixing tenant rows into it would
// make every loader run a merge against tenant data — the M40 canonical/overlay split exists for exactly
// this reason.
//
// TENANCY (ARCH-011 / ADR-0010): organization_id NOT NULL, canonical app.org_id RLS. No provider_entity_id /
// location_id: a tenant-local SKU definition is org-level config, not a per-CCN or per-Location record, and
// the same brief is stocked at every location (the per-location quantity lives in `par_stock`).
//
// CROSS-MODULE FK POLICY: only organization_id (M1 core) carries a real FK.
import { sql } from "drizzle-orm";
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "../organizations";

export const tenantSupplyItemExtension = pgTable(
  "tenant_supply_item_extension",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),

    name: text("name").notNull(),
    /** The agency's own shelf code. Unique per tenant — it is what the hub staff actually types. */
    localSkuCode: text("local_sku_code").notNull(),
    defaultUnit: text("default_unit").notNull(),

    // Defaults invert `supply_item`'s: a tenant-local item is presumed NON-billable (if it were billable it
    // would need a HCPCS code, which means it belongs in the platform catalog).
    isBillable: boolean("is_billable").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgLocalSkuUniq: uniqueIndex("m21_tenant_supply_item_org_sku_uniq").on(
      t.organizationId,
      t.localSkuCode,
    ),
    orgActiveIdx: index("tenant_supply_item_extension_org_active_idx")
      .on(t.organizationId)
      .where(sql`is_active = true`),
  }),
);

export type TenantSupplyItemExtensionRow = typeof tenantSupplyItemExtension.$inferSelect;
export type NewTenantSupplyItemExtensionRow = typeof tenantSupplyItemExtension.$inferInsert;
