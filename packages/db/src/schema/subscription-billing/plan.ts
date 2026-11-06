import { sql } from "drizzle-orm";
// @chartwarden/db — `plan` (M35 §3.3). The platform-owned pricing catalog (D11). PLATFORM-SHARED: no
// organization_id BY DESIGN — one plan definition is the same offer for every tenant, so read-all
// `USING (true)` TO chartwarden_app and writes only via chartwarden_admin (0143; the M38 code_system / M28
// fhir_capability_snapshot precedent). Listed in check-tenancy's NON_ORG_SCOPED set.
import {
  type AnyPgColumn,
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
    // Slice 2 (migration 1341) — the contracted census_banded model. All null on the retired flat tiers. A row is one
    // VERSION: slug = `<family_slug>-v<version>`; once `published_at` is set the prices are frozen (guard trigger), so a
    // subscription keeps the price it signed and a price change is a new row that supersedes this one.
    familySlug: text("family_slug"),
    version: integer("version").notNull().default(1),
    supersedesPlanId: uuid("supersedes_plan_id").references((): AnyPgColumn => plan.id, {
      onDelete: "restrict",
    }),
    perUserPriceCents: bigint("per_user_price_cents", { mode: "number" }),
    billingSoftwareBps: integer("billing_software_bps"),
    managedBillingBps: integer("managed_billing_bps"),
    contractTermMonths: integer("contract_term_months"),
    implementationFeeCents: bigint("implementation_fee_cents", { mode: "number" }),
    minimumMonthlyCents: bigint("minimum_monthly_cents", { mode: "number" }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
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
