// apps/backend/src/modules/35-subscription/pricing/statement-view.ts — what a statement looks like on the wire (slice 2).
// The row is the truth (migration 1342 holds its arithmetic as CHECK constraints); the view is a flat, explained rendering of it that
// the tenant, the platform operator and the Stripe seam all read the same way.
import type { schema } from "@chartwarden/db";
import type { BillingServiceMode } from "@chartwarden/types";

type StatementRow = typeof schema.subscriptionStatement.$inferSelect;

export interface PriorPeriodLineView {
  /** The closed month the money belongs to (`YYYY-MM`). */
  readonly sourceYearMonth: string;
  /** Net collections of that month that posted after its statement finalized. */
  readonly netCollectionsCents: number;
  readonly remittanceCount: number;
  readonly billingServiceMode: BillingServiceMode;
  /** The SOURCE month's own rate: a late remittance is never re-priced. */
  readonly billingBps: number;
  readonly feeCents: number;
}

export interface StatementView {
  readonly id: string;
  readonly periodYearMonth: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: "draft" | "final";
  readonly currencyCode: string;
  readonly inputs: {
    readonly staffCount: number;
    readonly staffCountBasis: "identity_filtered" | "ledger_unfiltered";
    readonly averageDailyCensus: number;
    readonly adcDaysObserved: number;
    readonly adcDaysInPeriod: number;
    /** Days of the month the subscription was live and billable (the go-live day counts). */
    readonly daysLive: number;
    readonly billingServiceMode: BillingServiceMode;
    readonly netCollectionsCents: number;
    readonly netCollectionsRemittanceCount: number;
    readonly netCollectionsPendingCount: number;
  };
  readonly terms: {
    readonly perUserPriceCents: number;
    readonly bandMinAdc: number;
    readonly bandFeeCents: number;
    readonly billingBps: number;
    readonly minimumMonthlyCents: number | null;
  };
  readonly platformFee: {
    readonly perUserSubtotalCents: number;
    readonly bandFeeCents: number;
    /** The greater side, prorated by the days live. */
    readonly feeCents: number;
    readonly basis: "per_user" | "census_band";
  };
  readonly billingFeeCents: number;
  readonly priorPeriodLines: readonly PriorPeriodLineView[];
  readonly priorPeriodFeeCents: number;
  readonly oneTimeFeeCents: number;
  /** The top-up that lifts the platform fee to the (prorated) plan minimum. */
  readonly minimumAdjustmentCents: number;
  readonly totalCents: number;
  /** An operator should look at this statement (unfiltered staff count, or a remittance of the month had not posted at close). */
  readonly needsReview: boolean;
  readonly computedAt: string;
  readonly finalizedAt: string | null;
}

export function toStatementView(row: StatementRow, currencyCode: string): StatementView {
  return {
    id: row.id,
    periodYearMonth: row.periodYearMonth,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    status: row.status,
    currencyCode,
    inputs: {
      staffCount: row.staffCount,
      staffCountBasis: row.staffCountBasis,
      averageDailyCensus: row.adcHundredths / 100,
      adcDaysObserved: row.adcDaysObserved,
      adcDaysInPeriod: row.adcDaysInPeriod,
      daysLive: row.daysLive,
      billingServiceMode: row.billingServiceMode,
      netCollectionsCents: row.netCollectionsCents,
      netCollectionsRemittanceCount: row.netCollectionsRemittanceCount,
      netCollectionsPendingCount: row.netCollectionsPendingCount,
    },
    terms: {
      perUserPriceCents: row.perUserPriceCents,
      bandMinAdc: row.bandMinAdc,
      bandFeeCents: row.bandFeeCents,
      billingBps: row.billingBps,
      minimumMonthlyCents: row.minimumMonthlyCents,
    },
    platformFee: {
      perUserSubtotalCents: row.perUserSubtotalCents,
      bandFeeCents: row.bandFeeCents,
      feeCents: row.platformFeeCents,
      basis: row.platformFeeBasis,
    },
    billingFeeCents: row.billingFeeCents,
    priorPeriodLines: row.priorPeriodLines.map((l) => ({ ...l })),
    priorPeriodFeeCents: row.priorPeriodFeeCents,
    oneTimeFeeCents: row.oneTimeFeeCents,
    minimumAdjustmentCents: row.minimumAdjustmentCents,
    totalCents: row.totalCents,
    needsReview: row.needsReview,
    computedAt: row.computedAt.toISOString(),
    finalizedAt: row.finalizedAt?.toISOString() ?? null,
  };
}

/**
 * THE STRIPE SEAM. Pushing a FINAL statement to Stripe as metered usage is not built: M35 has no Stripe subscription or meter wiring
 * (`subscription.stripe_subscription_id` is never written; the HTTP transport has no subscription operations). When it exists, bind a
 * port here: it receives the final statement (id = the idempotency key, `totalCents` and its lines = the amounts to report) and
 * returns the Stripe usage record id, which is stored in `stripe_usage_record_id` / `stripe_posted_at`. Until then a final statement
 * is computed, stored and readable, and the two columns stay null (the `subscription_statement_unposted_ix` index lists what waits).
 */
export interface StatementStripePort {
  pushFinalStatement(statement: StatementView): Promise<{ readonly usageRecordId: string }>;
}
