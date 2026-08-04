import { sql } from "drizzle-orm";
// @wardenx/db — `plan` (M35 §3.3). The platform-owned pricing catalog (D11). PLATFORM-SHARED: no
// organization_id BY DESIGN — one plan definition is the same offer for every tenant, so read-all
// `USING (true)` TO wardenx_app and writes only via wardenx_admin (0143; the M38 code_system / M28
// fhir_capability_snapshot precedent). Listed in check-tenancy's NON_ORG_SCOPED set.
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { billingCadence, planTier } from "../../enums";

export const plan = pgTable(
  "plan",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    tier: planTier("tier").notNull(),
    cadence: billingCadence("cadence").notNull(),
    basePriceCents: bigint("base_price_cents", { mode: "number" }).notNull(),
    currencyCode: text("currency_code").notNull().default("USD"),
    trialPeriodDays: integer("trial_period_days").notNull().default(14),
    isActive: boolean("is_active").notNull().default(false),
    deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
    stripeProductId: text("stripe_product_id"),
    stripePriceId: text("stripe_price_id"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
    validTo: timestamp("valid_to", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugUq: uniqueIndex("plan_slug_uq").on(t.slug),
    tierCadenceIx: index("plan_tier_cadence_ix").on(t.tier, t.cadence),
    activeIx: index("plan_active_ix").on(t.isActive).where(sql`is_active = true`),
  }),
);

export type PlanRow = typeof plan.$inferSelect;
export type NewPlanRow = typeof plan.$inferInsert;
