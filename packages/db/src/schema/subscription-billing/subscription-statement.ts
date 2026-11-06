// @chartwarden/db — `subscription_statement` (M35, slice 2 — migration 1342). One row per subscription per calendar month:
// the inputs (staff, ADC, net collections), the price terms applied, BOTH sides of the greater-of rule, and the total.
// `draft` while the month is open (recomputed, idempotently), `final` once closed; a final row is frozen by its trigger except
// for the Stripe push columns (the seam: nothing writes them until M35's Stripe subscription wiring exists).
// TENANT-SCOPED, SELECT-ONLY to the app role. Money is integer cents, rates integer basis points, ADC hundredths of a patient.
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { plan } from "./plan";
import { subscriptionRow } from "./subscription";
import type { BillingServiceModeValue } from "./subscription-contract";

/**
 * One prior-period line: net collections of a CLOSED month that posted after that month's statement finalized, billed on the next
 * open statement and stored with their SOURCE month (the rate is the source month's own, so it is never re-priced).
 */
export interface PriorPeriodLine {
  readonly sourceYearMonth: string;
  readonly netCollectionsCents: number;
  readonly remittanceCount: number;
  readonly billingServiceMode: BillingServiceModeValue;
  readonly billingBps: number;
  readonly feeCents: number;
}

export const subscriptionStatement = pgTable(
  "subscription_statement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id").notNull(),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptionRow.id, { onDelete: "restrict" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plan.id, { onDelete: "restrict" }),
    periodYearMonth: text("period_year_month").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    status: text("status").$type<"draft" | "final">().notNull(),
    // inputs
    staffCount: integer("staff_count").notNull(),
    staffCountBasis: text("staff_count_basis")
      .$type<"identity_filtered" | "ledger_unfiltered">()
      .notNull(),
    adcHundredths: integer("adc_hundredths").notNull(),
    adcDaysObserved: integer("adc_days_observed").notNull(),
    adcDaysInPeriod: integer("adc_days_in_period").notNull(),
    // days of the month the subscription was live and billable; the platform fee and minimum are charged by days_live / adc_days_in_period
    daysLive: integer("days_live").notNull(),
    billingServiceMode: text("billing_service_mode").$type<BillingServiceModeValue>().notNull(),
    netCollectionsCents: bigint("net_collections_cents", { mode: "number" }).notNull(),
    netCollectionsRemittanceCount: integer("net_collections_remittance_count").notNull(),
    netCollectionsPendingCount: integer("net_collections_pending_count").notNull(),
    // the price terms applied
    perUserPriceCents: bigint("per_user_price_cents", { mode: "number" }).notNull(),
    bandMinAdc: integer("band_min_adc").notNull(),
    bandFeeCents: bigint("band_fee_cents", { mode: "number" }).notNull(),
    billingBps: integer("billing_bps").notNull(),
    minimumMonthlyCents: bigint("minimum_monthly_cents", { mode: "number" }),
    // outputs
    perUserSubtotalCents: bigint("per_user_subtotal_cents", { mode: "number" }).notNull(),
    platformFeeCents: bigint("platform_fee_cents", { mode: "number" }).notNull(),
    platformFeeBasis: text("platform_fee_basis").$type<"per_user" | "census_band">().notNull(),
    billingFeeCents: bigint("billing_fee_cents", { mode: "number" }).notNull(),
    oneTimeFeeCents: bigint("one_time_fee_cents", { mode: "number" }).notNull(),
    minimumAdjustmentCents: bigint("minimum_adjustment_cents", { mode: "number" }).notNull(),
    priorPeriodLines: jsonb("prior_period_lines")
      .$type<readonly PriorPeriodLine[]>()
      .notNull()
      .default([]),
    priorPeriodFeeCents: bigint("prior_period_fee_cents", { mode: "number" }).notNull().default(0),
    totalCents: bigint("total_cents", { mode: "number" }).notNull(),
    needsReview: boolean("needs_review").notNull().default(false),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    stripeUsageRecordId: text("stripe_usage_record_id"),
    stripePostedAt: timestamp("stripe_posted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    periodUq: unique("subscription_statement_period_uq").on(t.subscriptionId, t.periodYearMonth),
    orgPeriodIx: index("subscription_statement_org_period_ix").on(
      t.organizationId,
      t.periodYearMonth,
    ),
    planIx: index("subscription_statement_plan_ix").on(t.planId),
  }),
);

export type SubscriptionStatementRow = typeof subscriptionStatement.$inferSelect;
export type NewSubscriptionStatementRow = typeof subscriptionStatement.$inferInsert;
