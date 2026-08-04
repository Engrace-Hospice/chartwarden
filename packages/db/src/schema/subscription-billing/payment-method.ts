import { sql } from "drizzle-orm";
// @wardenx/db — `payment_method` (M35 §3.3). TENANT-SCOPED, RLS on app.org_id (0143). Stripe-mirrored
// metadata only — no PAN, no CVV. `organization_id` is a logical uuid (M35-F04). §3.6 requests a
// field-exclusion posture on the `card_*`/`ach_*`/`sepa_*` metadata columns (defence-in-depth), applied
// by the generated write-audit trigger (0143).
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { paymentMethodKind } from "../../enums";

export const paymentMethod = pgTable(
  "payment_method",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    stripePaymentMethodId: text("stripe_payment_method_id").notNull(),
    kind: paymentMethodKind("kind").notNull(),
    cardBrand: text("card_brand"),
    cardLast4: text("card_last4"),
    cardExpMonth: integer("card_exp_month"),
    cardExpYear: integer("card_exp_year"),
    cardWalletKind: text("card_wallet_kind"),
    achBankName: text("ach_bank_name"),
    achAccountLast4: text("ach_account_last4"),
    achAccountType: text("ach_account_type"),
    sepaCountry: text("sepa_country"),
    sepaLast4: text("sepa_last4"),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    attachedAt: timestamp("attached_at", { withTimezone: true }).notNull().defaultNow(),
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    stripePmUq: uniqueIndex("payment_method_stripe_pm_uq").on(t.stripePaymentMethodId),
    orgDefaultUq: uniqueIndex("payment_method_org_default_uq")
      .on(t.organizationId)
      .where(sql`is_default = true AND is_active = true`),
    orgActiveIx: index("payment_method_org_active_ix").on(t.organizationId, t.isActive),
  }),
);

export type PaymentMethodRow = typeof paymentMethod.$inferSelect;
export type NewPaymentMethodRow = typeof paymentMethod.$inferInsert;
