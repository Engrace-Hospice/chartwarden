// apps/backend/src/modules/35-subscription/pricing/preview.ts — the PRICE PREVIEW (slice 2): what a tenant would pay on a plan for
// the inputs an operator enters while pricing a draft tenant. Pure: the plan arrives as the view the editor already returns, so a
// draft, a published or an archived version can all be previewed, and the answer is exactly the math a statement will use.
import { computeStatementAmounts } from "@chartwarden/subscription-billing";
import type { BillingServiceMode } from "@chartwarden/types";
import { ChartWardenError } from "@chartwarden/types";
import type { PricingPlanView } from "./plan-service";

export interface PricePreviewInput {
  readonly staffCount: number;
  /** Expected average daily census, in patients (up to two decimals). */
  readonly averageDailyCensus: number;
  /** Expected net collections of a month, integer cents. Ignored (priced at nothing) when the tenant bills outside ChartWarden. */
  readonly expectedNetCollectionsCents: number;
  readonly billingServiceMode: BillingServiceMode;
}

export interface PricePreview {
  readonly plan: Pick<
    PricingPlanView,
    "id" | "slug" | "name" | "version" | "status" | "currencyCode"
  >;
  readonly inputs: PricePreviewInput;
  readonly platformFee: {
    readonly perUserSubtotalCents: number;
    readonly bandFeeCents: number;
    readonly bandMinAdc: number;
    readonly bandMaxAdc: number | null;
    readonly feeCents: number;
    readonly basis: "per_user" | "census_band";
  };
  readonly billing: {
    readonly mode: BillingServiceMode;
    readonly bps: number;
    readonly feeCents: number;
  };
  readonly minimumAdjustmentCents: number;
  /** Platform fee + billing fee + any top-up to the plan minimum: what a typical month costs. */
  readonly monthlyCents: number;
  /** The one-time implementation fee, charged on the contract's first statement. */
  readonly implementationFeeCents: number;
  readonly firstMonthCents: number;
  readonly contractTermMonths: number;
}

export function buildPricePreview(plan: PricingPlanView, input: PricePreviewInput): PricePreview {
  if (
    plan.perUserPriceCents === null ||
    plan.billingSoftwareBps === null ||
    plan.managedBillingBps === null ||
    plan.contractTermMonths === null ||
    plan.implementationFeeCents === null
  ) {
    throw new ChartWardenError(
      "PLAN_PRICING_INCOMPLETE",
      "this plan has no prices to preview yet",
      422,
    );
  }
  // The expected census in hundredths of a patient, the unit a statement's ADC is in.
  const adc = Math.round(input.averageDailyCensus * 100);
  const amounts = computeStatementAmounts(
    {
      perUserPriceCents: plan.perUserPriceCents,
      bands: plan.bands,
      billingSoftwareBps: plan.billingSoftwareBps,
      managedBillingBps: plan.managedBillingBps,
      minimumMonthlyCents: plan.minimumMonthlyCents,
    },
    {
      staffCount: input.staffCount,
      adcHundredths: adc,
      netCollectionsCents: input.expectedNetCollectionsCents,
      mode: input.billingServiceMode,
      oneTimeFeeCents: 0,
    },
  );
  const band = plan.bands.find((b) => b.minAdc === amounts.bandMinAdc);
  const monthlyCents = amounts.totalCents;
  return {
    plan: {
      id: plan.id,
      slug: plan.slug,
      name: plan.name,
      version: plan.version,
      status: plan.status,
      currencyCode: plan.currencyCode,
    },
    inputs: input,
    platformFee: {
      perUserSubtotalCents: amounts.perUserSubtotalCents,
      bandFeeCents: amounts.bandFeeCents,
      bandMinAdc: amounts.bandMinAdc,
      bandMaxAdc: band?.maxAdc ?? null,
      feeCents: amounts.platformFeeCents,
      basis: amounts.platformFeeBasis,
    },
    billing: {
      mode: input.billingServiceMode,
      bps: amounts.billingBps,
      feeCents: amounts.billingFeeCents,
    },
    minimumAdjustmentCents: amounts.minimumAdjustmentCents,
    monthlyCents,
    implementationFeeCents: plan.implementationFeeCents,
    firstMonthCents: monthlyCents + plan.implementationFeeCents,
    contractTermMonths: plan.contractTermMonths,
  };
}
