// @chartwarden/db — `vendor_routing_rule` (M21 §3.1.5). D4's deterministic routing ladder: which vendor (or
// internal hub, or partner pharmacy) fulfils a given SKU at a given Location for a given tenant. Resolution
// is a single ORDER BY over `scope_kind` specificity then `precedence_priority` — there is NO fallback
// chain. The §3.2 draft's `fallback_vendor_ids_jsonb` + `fulfillment_channel` model is explicitly REMOVED by
// §3.0: a fallback list means two coordinators reading the same rules can dispatch to different vendors, and
// a survey asks "why did this bed come from Apria" expecting one answer.
//
// The resolved rule is frozen onto `supply_request.routing_rule_resolved_jsonb` at the `vendor_assigned`
// transition, so editing a rule tomorrow never rewrites yesterday's dispatch.
//
// TENANCY (ARCH-011 / ADR-0010): organization_id is NULLABLE and paired with `scope_kind = 'platform'` —
// the same floor-plus-overlay shape as `comfort_kit_template`, enforced by the CHECK below. RLS reads
// `scope_kind = 'platform' OR organization_id = app.org_id` for SELECT and the plain org predicate for
// writes (migration 0106), so a tenant sees the platform default and can never edit it. D4 ships NO
// platform rows today (§3.1.13): every tenant must configure at least its own tenant-scope default, and
// `validateVendorRoutingAtBoot()` is what refuses a tenant that has not.
//
// No provider_entity_id: a routing rule is org+Location config. `scope_id` carries the Location for
// `scope_kind = 'location'` (and the SKU for `'sku'`), which is why there is no separate location_id column.
//
// CROSS-MODULE FK POLICY: only organization_id (M1 core) carries a real FK. `assigned_vendor_id` is a
// logical uuid into M40's DmeVendor and `scope_id` is polymorphic (supply_item id | location id | org id),
// so neither can be constrained — both are validated at the write boundary.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { pharmacyDispatchMode, supplyFulfillmentMode, vendorRoutingScopeKind } from "../../enums";
import { organizations } from "../organizations";

export const vendorRoutingRule = pgTable(
  "vendor_routing_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // NULL on a platform-scope rule ONLY (see the CHECK below).
    organizationId: uuid("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),

    scopeKind: vendorRoutingScopeKind("scope_kind").notNull(),
    /** skuId | locationId | orgId | NULL(platform) — polymorphic, hence no FK. */
    scopeId: uuid("scope_id"),
    /** A HCPCS prefix ('E02') or the literal 'comfort_kit'. NULL matches every SKU in scope. */
    skuClassPattern: text("sku_class_pattern"),

    assignedVendorId: uuid("assigned_vendor_id"), // logical FK → M40 DmeVendor; NULL for the internal hub
    assignedFulfillmentMode: supplyFulfillmentMode("assigned_fulfillment_mode").notNull(),
    defaultPharmacyDispatchMode: pharmacyDispatchMode("default_pharmacy_dispatch_mode"),

    /** Lower wins within one `scope_kind`. Specificity (sku > location > tenant > platform) wins first. */
    precedencePriority: integer("precedence_priority").notNull().default(100),

    isActive: boolean("is_active").notNull().default(true),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    orgActiveIdx: index("vendor_routing_rule_org_active_idx")
      .on(t.organizationId, t.scopeKind, t.scopeId)
      .where(sql`is_active = true AND effective_to IS NULL`),
    scopeLookupIdx: index("vendor_routing_rule_scope_lookup_idx")
      .on(t.scopeKind, t.scopeId, t.skuClassPattern)
      .where(sql`is_active = true`),

    platformIsOrgless: check(
      "m21_routing_rule_platform_scope",
      sql`(scope_kind = 'platform' AND organization_id IS NULL)
          OR (scope_kind <> 'platform' AND organization_id IS NOT NULL)`,
    ),
    // sku / location scopes name the thing they scope TO; tenant / platform scopes do not.
    scopedKindsHaveTarget: check(
      "m21_routing_rule_scope_target",
      sql`(scope_kind IN ('sku', 'location') AND scope_id IS NOT NULL)
          OR scope_kind IN ('tenant', 'platform')`,
    ),
    vendorModeHasVendor: check(
      "m21_routing_rule_vendor_mode",
      sql`assigned_fulfillment_mode <> 'vendor' OR assigned_vendor_id IS NOT NULL`,
    ),
    effectiveWindowOrdered: check(
      "m21_routing_rule_effective_window",
      sql`effective_to IS NULL OR effective_to > effective_from`,
    ),
  }),
);

export type VendorRoutingRuleRow = typeof vendorRoutingRule.$inferSelect;
export type NewVendorRoutingRuleRow = typeof vendorRoutingRule.$inferInsert;
