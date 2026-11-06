// apps/backend/src/modules/35-subscription/pricing/pricing-typebox.ts — slice 2 (tenant pricing) wire contracts: the request schemas
// the routes `parse(...)` and the response DTOs the OpenAPI enrichment registry reuses. Named `*-typebox` (never `*schema*`) so the
// table-ownership heuristic never mistakes it for a Drizzle import. Every money field is INTEGER CENTS, every rate INTEGER BASIS
// POINTS; no body or query carries an organisation id or an acting membership id (the tenant is the path slug, the operator the session).
import { ValidationError } from "@chartwarden/types";
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// Formats this file uses, registered here so it never depends on another module's import order (the registry is process-global).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid"))
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}
if (!FormatRegistry.Has("date")) {
  FormatRegistry.Set("date", (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
}

const uuid = () => Type.String({ format: "uuid" });
const iso = () => Type.String({ format: "date-time" });
const isoNull = () => Type.Union([iso(), Type.Null()]);
const strNull = () => Type.Union([Type.String(), Type.Null()]);
const intNull = () => Type.Union([Type.Integer(), Type.Null()]);

/** $1 billion, in cents: far above any real price and far below the safe-integer ceiling the math relies on. */
const MAX_CENTS = 100_000_000_000;
const MAX_ADC = 100_000;
/**
 * Staff x per-user price is a plain JS product, so the two caps are chosen to keep it exact: 1,000,000 staff x 1,000,000,000 cents
 * ($10 million a seat a month, far above any price) is 10^15, below 2^53 (9.007 x 10^15). The pure math also refuses an unsafe product.
 */
export const MAX_STAFF = 1_000_000;
const MAX_PER_USER_CENTS = 1_000_000_000;
const cents = () => Type.Integer({ minimum: 0, maximum: MAX_CENTS });
const bps = () => Type.Integer({ minimum: 0, maximum: 10_000 });
const REASON = Type.String({ minLength: 1, maxLength: 2000 });

export const BillingServiceModeLit = Type.Union([
  Type.Literal("none"),
  Type.Literal("billing_software"),
  Type.Literal("managed_billing"),
]);

// ── requests ────────────────────────────────────────────────────────────────────────────────────────
export const PricingBandBody = Type.Object(
  { minAdc: Type.Integer({ minimum: 0, maximum: MAX_ADC }), monthlyFeeCents: cents() },
  { additionalProperties: false },
);
const pricingFields = {
  name: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.Optional(Type.Union([Type.String({ maxLength: 1000 }), Type.Null()])),
  currencyCode: Type.Optional(Type.String({ pattern: "^[A-Z]{3}$" })),
  perUserPriceCents: Type.Integer({ minimum: 0, maximum: MAX_PER_USER_CENTS }),
  bands: Type.Array(PricingBandBody, { minItems: 1, maxItems: 20 }),
  billingSoftwareBps: bps(),
  managedBillingBps: bps(),
  contractTermMonths: Type.Integer({ minimum: 1, maximum: 120 }),
  implementationFeeCents: cents(),
  minimumMonthlyCents: Type.Union([cents(), Type.Null()]),
  reason: REASON,
};
export const CreatePricingPlanBody = Type.Object(
  {
    familySlug: Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", minLength: 3, maxLength: 64 }),
    ...pricingFields,
  },
  { additionalProperties: false },
);
export const ReplacePricingDraftBody = Type.Object(pricingFields, { additionalProperties: false });
export const PricingReasonBody = Type.Object({ reason: REASON }, { additionalProperties: false });
export const PricingPlanParams = Type.Object({ id: uuid() });
export const OrgSlugParams = Type.Object({
  orgSlug: Type.String({ minLength: 1, maxLength: 128 }),
});

export const PricePreviewBody = Type.Object(
  {
    planId: uuid(),
    staffCount: Type.Integer({ minimum: 0, maximum: MAX_STAFF }),
    /** Expected average daily census, in patients (up to two decimals are kept). */
    averageDailyCensus: Type.Number({ minimum: 0, maximum: MAX_ADC }),
    expectedNetCollectionsCents: Type.Integer({ minimum: 0, maximum: MAX_CENTS }),
    billingServiceMode: BillingServiceModeLit,
    /** The planned go-live date: when given, the first month is priced by the days live from that day (the go-live day counts). */
    plannedGoLiveOn: Type.Optional(Type.String({ format: "date" })),
  },
  { additionalProperties: false },
);

export const CreateTenantContractBody = Type.Object(
  {
    planSlug: Type.String({ minLength: 3, maxLength: 80 }),
    billingServiceMode: BillingServiceModeLit,
    orderFormRef: Type.Optional(Type.Union([Type.String({ maxLength: 600 }), Type.Null()])),
    reason: REASON,
  },
  { additionalProperties: false },
);
export const SetBillingServiceModeBody = Type.Object(
  { billingServiceMode: BillingServiceModeLit, reason: REASON },
  { additionalProperties: false },
);

// ── responses ───────────────────────────────────────────────────────────────────────────────────────
const BandDto = Type.Object({
  minAdc: Type.Integer(),
  maxAdc: intNull(),
  monthlyFeeCents: Type.Integer(),
});
export const PricingPlanDto = Type.Object({
  id: uuid(),
  familySlug: Type.String(),
  version: Type.Integer(),
  slug: Type.String(),
  name: Type.String(),
  description: strNull(),
  status: Type.Union([Type.Literal("draft"), Type.Literal("published"), Type.Literal("archived")]),
  offered: Type.Boolean(),
  currencyCode: Type.String(),
  perUserPriceCents: intNull(),
  bands: Type.Array(BandDto),
  billingSoftwareBps: intNull(),
  managedBillingBps: intNull(),
  contractTermMonths: intNull(),
  implementationFeeCents: intNull(),
  minimumMonthlyCents: intNull(),
  supersedesPlanId: Type.Union([uuid(), Type.Null()]),
  publishedAt: isoNull(),
  archivedAt: isoNull(),
  createdAt: iso(),
  updatedAt: iso(),
});
export const PricingPlanListDto = Type.Array(PricingPlanDto);
export const PricingDefaultsDto = Type.Object({
  bandThresholds: Type.Array(Type.Integer()),
  currencyCode: Type.String(),
});

export const PricePreviewDto = Type.Object({
  plan: Type.Object({
    id: uuid(),
    slug: Type.String(),
    name: Type.String(),
    version: Type.Integer(),
    status: Type.Union([
      Type.Literal("draft"),
      Type.Literal("published"),
      Type.Literal("archived"),
    ]),
    currencyCode: Type.String(),
  }),
  inputs: Type.Object({
    staffCount: Type.Integer(),
    averageDailyCensus: Type.Number(),
    expectedNetCollectionsCents: Type.Integer(),
    billingServiceMode: BillingServiceModeLit,
    plannedGoLiveOn: Type.Optional(Type.String({ format: "date" })),
  }),
  platformFee: Type.Object({
    perUserSubtotalCents: Type.Integer(),
    bandFeeCents: Type.Integer(),
    bandMinAdc: Type.Integer(),
    bandMaxAdc: intNull(),
    feeCents: Type.Integer(),
    basis: Type.Union([Type.Literal("per_user"), Type.Literal("census_band")]),
  }),
  billing: Type.Object({
    mode: BillingServiceModeLit,
    bps: Type.Integer(),
    feeCents: Type.Integer(),
  }),
  minimumAdjustmentCents: Type.Integer(),
  monthlyCents: Type.Integer(),
  implementationFeeCents: Type.Integer(),
  firstMonthCents: Type.Integer(),
  /** Days of the first month the tenant would be live (null without a planned go-live date: the first month is then priced whole). */
  firstMonthDaysLive: intNull(),
  firstMonthDaysInPeriod: intNull(),
  contractTermMonths: Type.Integer(),
});

const contractFields = {
  subscriptionId: uuid(),
  plan: Type.Object({
    id: uuid(),
    slug: Type.String(),
    name: Type.String(),
    version: Type.Integer(),
    currencyCode: Type.String(),
  }),
  billingServiceMode: BillingServiceModeLit,
  billingBps: Type.Integer(),
  /** A recorded change that has not taken effect yet (it takes effect from the 1st of the next month). */
  pendingBillingServiceMode: Type.Union([
    Type.Object({
      billingServiceMode: BillingServiceModeLit,
      effectiveOn: Type.String({ format: "date" }),
    }),
    Type.Null(),
  ]),
  contractStartOn: Type.String({ format: "date" }),
  contractTermMonths: Type.Integer(),
  contractEndsOn: Type.String({ format: "date" }),
  perUserPriceCents: Type.Integer(),
  bands: Type.Array(BandDto),
  billingSoftwareBps: Type.Integer(),
  managedBillingBps: Type.Integer(),
  implementationFeeCents: Type.Integer(),
  minimumMonthlyCents: intNull(),
};
export const ContractDto = Type.Object(contractFields);
export const PlatformContractDto = Type.Object({
  ...contractFields,
  signedByMembershipId: uuid(),
  signedReason: Type.String(),
  orderFormRef: strNull(),
});

export const StatementDto: TSchema = Type.Object({
  id: uuid(),
  periodYearMonth: Type.String(),
  periodStart: iso(),
  periodEnd: iso(),
  status: Type.Union([Type.Literal("draft"), Type.Literal("final")]),
  currencyCode: Type.String(),
  inputs: Type.Object({
    staffCount: Type.Integer(),
    staffCountBasis: Type.Union([
      Type.Literal("identity_filtered"),
      Type.Literal("ledger_unfiltered"),
    ]),
    averageDailyCensus: Type.Number(),
    adcDaysObserved: Type.Integer(),
    adcDaysInPeriod: Type.Integer(),
    daysLive: Type.Integer(),
    billingServiceMode: BillingServiceModeLit,
    netCollectionsCents: Type.Integer(),
    netCollectionsRemittanceCount: Type.Integer(),
    netCollectionsPendingCount: Type.Integer(),
  }),
  terms: Type.Object({
    perUserPriceCents: Type.Integer(),
    bandMinAdc: Type.Integer(),
    bandFeeCents: Type.Integer(),
    billingBps: Type.Integer(),
    minimumMonthlyCents: intNull(),
  }),
  platformFee: Type.Object({
    perUserSubtotalCents: Type.Integer(),
    bandFeeCents: Type.Integer(),
    feeCents: Type.Integer(),
    basis: Type.Union([Type.Literal("per_user"), Type.Literal("census_band")]),
  }),
  billingFeeCents: Type.Integer(),
  priorPeriodLines: Type.Array(
    Type.Object({
      sourceYearMonth: Type.String(),
      netCollectionsCents: Type.Integer(),
      remittanceCount: Type.Integer(),
      billingServiceMode: BillingServiceModeLit,
      billingBps: Type.Integer(),
      feeCents: Type.Integer(),
    }),
  ),
  priorPeriodFeeCents: Type.Integer(),
  oneTimeFeeCents: Type.Integer(),
  minimumAdjustmentCents: Type.Integer(),
  totalCents: Type.Integer(),
  needsReview: Type.Boolean(),
  computedAt: iso(),
  finalizedAt: isoNull(),
});

export const TenantPricingDto = Type.Object({
  contract: Type.Union([ContractDto, Type.Null()]),
  latestStatement: Type.Union([StatementDto, Type.Null()]),
});
export const PlatformPricingDto = Type.Object({
  contract: Type.Union([PlatformContractDto, Type.Null()]),
  statements: Type.Array(StatementDto),
});
export const CreateTenantContractResponseDto = Type.Object({
  contract: PlatformContractDto,
  resumed: Type.Boolean(),
  planContractStep: Type.Object({
    status: Type.Union([
      Type.Literal("settled"),
      Type.Literal("already_settled"),
      Type.Literal("pending"),
    ]),
    reason: Type.Optional(Type.String()),
  }),
});

/**
 * Strict parse: NO type coercion. The shared M35 `parse` runs TypeBox `Value.Convert` first (it must, for query strings), and Convert
 * truncates 1.5 to 1 for an Integer: for a price a body of 1.5 cents would be stored as 1. Pricing bodies are JSON, so they are
 * checked exactly as sent.
 */
export function parseStrict<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  const value = raw ?? {};
  if (!Value.Check(schema, value)) {
    const first = [...Value.Errors(schema, value)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return value as Static<T>;
}
