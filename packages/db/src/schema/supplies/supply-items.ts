// @chartwarden/db — `supply_item` (M21 §3.1.3). D11's PLATFORM-SHARED canonical SKU catalog: one row per
// real-world billable HCPCS-keyed item (E0260 semi-electric hospital bed, E1390 oxygen concentrator, the
// kit medications by RxNorm/NDC). The same answer for every tenant, so the row carries NO organization_id
// at all — the M38 `code_system` / M39 `consent_type_catalog` / M22 `form_template` posture. Tenant-local,
// non-billable items live in the sibling `tenant_supply_item_extension` overlay instead.
//
// TENANCY (ARCH-011 / ADR-0010 — the DELIBERATE opt-out): `supply_item` is registered in the
// `NON_ORG_SCOPED` set of scripts/check-tenancy.ts. Dual-grant RLS in migration 0106: read-all
// `USING (is_active = true)` TO chartwarden_app, writes only via chartwarden_admin (the platform catalog loader).
// It audits through the M1 baseline `chartwarden_audit_trigger()` rather than the M4 generator, because the
// generator's body reads `NEW.organization_id`, which this table does not have (the M22 form_template
// precedent). Effective-dating (`effective_from`/`effective_to`) is how a HCPCS code is retired without
// orphaning the historical `supply_request` rows that resolved against it.
//
// §3.0 / M21-F04 FOLD: the four clinical-attribute flags the §3.2 draft carried on its own fork of this
// table (`is_controlled_substance` / `requires_lot_tracking` / `requires_expiration_tracking` /
// `is_serialized_asset`) are folded here as NULLABLE columns, exactly as §3.0's reconciliation table
// directs. Nullable, not defaulted-false: "we have not classified this SKU" and "this SKU is definitely
// not controlled" are different facts, and the §2.5 dispatch path must be able to tell them apart before
// it decides whether a lot number is mandatory.
//
// CROSS-MODULE FK POLICY: none — this table references nothing. `rxnorm`/`ndc` are M38 terminology codes
// carried as text (M38 owns the concept tables; M21 stores the code, never a FK into another module).
import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { uuid } from "drizzle-orm/pg-core";

export const supplyItem = pgTable(
  "supply_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Billing / terminology identity. `hcpcs` is the M23 claim-line join key; `rxnorm`/`ndc` carry the
    // drug-supply items that back a comfort-kit template medication.
    hcpcs: text("hcpcs"),
    rxnorm: text("rxnorm"),
    ndc: text("ndc"),

    name: text("name").notNull(),
    /** 'E' | 'A' | 'B' | 'K' | 'L' | 'Q' | 'internal' — the HCPCS letter family (`SupplySkuClass`). */
    skuClass: text("sku_class").notNull(),
    defaultUnit: text("default_unit").notNull(),

    isBillable: boolean("is_billable").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    /** Always true on this table; the column exists so a read that unions the tenant overlay stays typed. */
    isPlatform: boolean("is_platform").notNull().default(true),

    // §3.0 fold — the clinical attributes the dispatch path reads. NULL = unclassified (see header).
    isControlledSubstance: boolean("is_controlled_substance"),
    requiresLotTracking: boolean("requires_lot_tracking"),
    requiresExpirationTracking: boolean("requires_expiration_tracking"),
    isSerializedAsset: boolean("is_serialized_asset"),

    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // §3.1.3 — one LIVE row per HCPCS code. Partial on `effective_to IS NULL` so a retired code can be
    // superseded by a new row without a unique collision.
    hcpcsActiveUniq: uniqueIndex("supply_item_hcpcs_active_uniq")
      .on(t.hcpcs)
      .where(sql`hcpcs IS NOT NULL AND effective_to IS NULL`),
    skuClassIdx: index("supply_item_sku_class_idx").on(t.skuClass).where(sql`is_active = true`),

    // A billable item without a HCPCS code cannot appear on an M23 claim line — reject the row rather
    // than discover it at claim assembly.
    billableRequiresHcpcs: check(
      "m21_supply_item_billable_requires_hcpcs",
      sql`hcpcs IS NOT NULL OR is_billable = false`,
    ),
    effectiveWindowOrdered: check(
      "m21_supply_item_effective_window",
      sql`effective_to IS NULL OR effective_to > effective_from`,
    ),
  }),
);

export type SupplyItemRow = typeof supplyItem.$inferSelect;
export type NewSupplyItemRow = typeof supplyItem.$inferInsert;
