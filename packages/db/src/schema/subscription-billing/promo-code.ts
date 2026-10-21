// @chartwarden/db — `promo_code` (M35 §3.3). Mirror of a Stripe coupon + promotion code. PLATFORM-SHARED
// (no organization_id) — read-all, platform-only write. Listed in check-tenancy's NON_ORG_SCOPED set.
import {
  bigint,
  boolean,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { promoDuration, promoKind } from "../../enums";

export const promoCode = pgTable(
  "promo_code",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stripeCouponId: text("stripe_coupon_id").notNull(),
    stripePromotionCodeId: text("stripe_promotion_code_id").notNull(),
    code: text("code").notNull(),
    kind: promoKind("kind").notNull(),
    percentOff: integer("percent_off"),
    fixedOffCents: bigint("fixed_off_cents", { mode: "number" }),
    duration: promoDuration("duration").notNull(),
    durationInMonths: integer("duration_in_months"),
    validFrom: timestamp("valid_from", { withTimezone: true }),
    validTo: timestamp("valid_to", { withTimezone: true }),
    maxRedemptions: integer("max_redemptions"),
    redemptionCount: integer("redemption_count").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    codeUq: uniqueIndex("promo_code_code_uq").on(t.code),
    stripeCouponUq: uniqueIndex("promo_code_stripe_coupon_uq").on(t.stripeCouponId),
    stripePromoUq: uniqueIndex("promo_code_stripe_promo_uq").on(t.stripePromotionCodeId),
  }),
);

export type PromoCodeRow = typeof promoCode.$inferSelect;
export type NewPromoCodeRow = typeof promoCode.$inferInsert;
