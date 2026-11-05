// @chartwarden/db — `addon` (M35, ADR-0108). The platform-owned add-on catalog, shaped like `plan` (D11: platform
// pricing, no tenant overlay). PLATFORM-SHARED: no organization_id BY DESIGN; read-all to chartwarden_app, writes only
// as chartwarden_admin (migration 1321). Listed in check-tenancy's NON_ORG_SCOPED set. `unitPriceCents` is null until
// platform ops prices it (Stripe charging is deferred, ADR-0108 D7).
//
// Exported as `addonRow` (not `addon`): the arch:tables ownership scanner keys on the Drizzle const name with a word
// boundary, and "addon" is ordinary prose elsewhere (the `subscriptionRow` / `dunningStateRow` precedent).
import { bigint, boolean, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { usageEventType } from "../../enums";

export const addonRow = pgTable(
  "addon",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    entitlementKey: text("entitlement_key").notNull(),
    meterEventType: usageEventType("meter_event_type").notNull(),
    unitPriceCents: bigint("unit_price_cents", { mode: "number" }),
    currencyCode: text("currency_code").notNull().default("USD"),
    isActive: boolean("is_active").notNull().default(true),
    stripeProductId: text("stripe_product_id"),
    stripePriceId: text("stripe_price_id"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugUq: uniqueIndex("addon_slug_uq").on(t.slug),
    entitlementKeyUq: uniqueIndex("addon_entitlement_key_uq").on(t.entitlementKey),
  }),
);

export type AddonRow = typeof addonRow.$inferSelect;
