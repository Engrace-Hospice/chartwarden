// apps/backend/src/modules/35-subscription/routes/subscription-typebox.ts — M35 (§4.4) wire contracts.
//
// TypeBox path-param / query / body request schemas for the §4.1 tenant + §4.2 admin routes AND the §4.4
// response DTOs the OpenAPI enrichment registry reuses, plus the `parse(...)` helper. Named
// `subscription-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox
// import for a Drizzle one (the M27 `cost-report-typebox` precedent). Validation runs through TypeBox
// `Value` → M1's VALIDATION_FAILED envelope. Org/actor/membership binding is ALWAYS server-side
// (request.context) — no body/query carries an org id or an authoring/approving membership id.
//
// VOCAB NOTE: the string-literal unions MIRROR the FROZEN `@chartwarden/db` pgEnum value lists
// (packages/db/src/schema/subscription-billing/*) and the leaf `@chartwarden/types` unions; schema wins on
// conflict. M35 carries NO PHI (§8.5); every money field is INTEGER CENTS.
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@chartwarden/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}
if (!FormatRegistry.Has("date")) {
  FormatRegistry.Set("date", (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
}

const uuid = () => Type.String({ format: "uuid" });
const isoNull = () => Type.Union([Type.String({ format: "date-time" }), Type.Null()]);
const dateNull = () => Type.Union([Type.String({ format: "date" }), Type.Null()]);
const strNull = () => Type.Union([Type.String(), Type.Null()]);
const intNull = () => Type.Union([Type.Integer(), Type.Null()]);

const SubscriptionStatusLit = Type.Union([
  Type.Literal("trialing"),
  Type.Literal("active"),
  Type.Literal("past_due"),
  Type.Literal("at_risk"),
  Type.Literal("suspended"),
  Type.Literal("canceled"),
  Type.Literal("paused"),
]);
const DunningStageLit = Type.Union([
  Type.Literal("none"),
  Type.Literal("day_1"),
  Type.Literal("day_7"),
  Type.Literal("day_14"),
  Type.Literal("day_21"),
  Type.Literal("day_28_suspend"),
  Type.Literal("day_60_cancel"),
  Type.Literal("resolved"),
]);
const InvoiceStatusLit = Type.Union([
  Type.Literal("draft"),
  Type.Literal("open"),
  Type.Literal("paid"),
  Type.Literal("void"),
  Type.Literal("uncollectible"),
]);
const PlanTierLit = Type.Union([
  Type.Literal("starter"),
  Type.Literal("professional"),
  Type.Literal("enterprise"),
]);
const CadenceLit = Type.Union([Type.Literal("monthly"), Type.Literal("annual")]);
const ProrationLit = Type.Union([
  Type.Literal("create_prorations"),
  Type.Literal("always_invoice"),
  Type.Literal("none"),
]);

// ── path params + list query ────────────────────────────────────────────────────────────────────────────

export const IdParamsSchema = Type.Object({ id: uuid() });
export const SubIdParamsSchema = Type.Object({ subscriptionId: uuid() });
export const PlanMeterParamsSchema = Type.Object({ id: uuid(), meterId: uuid() });
export const OrgUsageParamsSchema = Type.Object({ organizationId: uuid() });
export const StripeEventParamsSchema = Type.Object({ eventId: Type.String({ minLength: 1 }) });

export const ListQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export const AdminSubscriptionListQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  status: Type.Optional(SubscriptionStatusLit),
  organizationId: Type.Optional(uuid()),
});
export const DunningListQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  stage: Type.Optional(DunningStageLit),
});

// ── tenant request bodies (§4.1 / §4.4) ─────────────────────────────────────────────────────────────────

export const CreateSubscriptionBodySchema = Type.Object({
  planSlug: Type.String({ minLength: 1 }),
  paymentMethodId: Type.Optional(uuid()),
  promoCode: Type.Optional(Type.String({ minLength: 1 })),
});
export const ChangePlanBodySchema = Type.Object({
  newPlanSlug: Type.String({ minLength: 1 }),
  prorationBehavior: ProrationLit,
});
export const ApplyPromoBodySchema = Type.Object({ promoCode: Type.String({ minLength: 1 }) });
export const AttachPaymentMethodBodySchema = Type.Object({
  stripePaymentMethodId: Type.String({ minLength: 1 }),
  setAsDefault: Type.Optional(Type.Boolean()),
});

// ── admin request bodies (§4.2) ─────────────────────────────────────────────────────────────────────────

export const CreatePlanBodySchema = Type.Object({
  slug: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  tier: PlanTierLit,
  cadence: CadenceLit,
  basePriceCents: Type.Integer({ minimum: 0 }),
  currencyCode: Type.String({ minLength: 3, maxLength: 3 }),
  trialPeriodDays: Type.Integer({ minimum: 0, maximum: 365 }),
});
export const UpdatePlanBodySchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1 })),
  description: Type.Optional(Type.String()),
  basePriceCents: Type.Optional(Type.Integer({ minimum: 0 })),
  trialPeriodDays: Type.Optional(Type.Integer({ minimum: 0, maximum: 365 })),
});
export const AddMeterBodySchema = Type.Object({
  eventType: Type.String({ minLength: 1 }),
  label: Type.String({ minLength: 1 }),
  inclusiveQuantity: Type.Integer({ minimum: 0 }),
  overageUnitPriceCents: Type.Integer({ minimum: 0 }),
  billingAggregation: Type.Union([
    Type.Literal("sum"),
    Type.Literal("last"),
    Type.Literal("count"),
  ]),
  warningThresholdPercent: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export const UpdateMeterBodySchema = Type.Object({
  inclusiveQuantity: Type.Optional(Type.Integer({ minimum: 0 })),
  overageUnitPriceCents: Type.Optional(Type.Integer({ minimum: 0 })),
  warningThresholdPercent: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});
export const PauseSubscriptionBodySchema = Type.Object({
  pausedUntil: Type.Optional(Type.String({ format: "date-time" })),
});
export const RevokePromoBodySchema = Type.Object({ applicationId: uuid() });
export const RequestRefundBodySchema = Type.Object({
  invoiceId: uuid(),
  amountCents: Type.Integer({ minimum: 1 }),
  kind: Type.Union([Type.Literal("full"), Type.Literal("partial"), Type.Literal("credit_only")]),
  reasonCode: Type.Union([
    Type.Literal("duplicate"),
    Type.Literal("fraudulent"),
    Type.Literal("requested_by_customer"),
    Type.Literal("other"),
  ]),
  reasonDetail: Type.String({ minLength: 40, maxLength: 4000 }),
});
export const DenyRefundBodySchema = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 4000 }),
});
export const CreatePromoBodySchema = Type.Object({
  code: Type.String({ minLength: 1 }),
  stripeCouponId: Type.String({ minLength: 1 }),
  stripePromotionCodeId: Type.String({ minLength: 1 }),
  kind: Type.Union([Type.Literal("percent_off"), Type.Literal("amount_off")]),
  percentOff: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  fixedOffCents: Type.Optional(Type.Integer({ minimum: 1 })),
  duration: Type.Union([Type.Literal("once"), Type.Literal("repeating"), Type.Literal("forever")]),
  durationInMonths: Type.Optional(Type.Integer({ minimum: 1 })),
  validFrom: Type.Optional(Type.String({ format: "date-time" })),
  validTo: Type.Optional(Type.String({ format: "date-time" })),
  maxRedemptions: Type.Optional(Type.Integer({ minimum: 1 })),
});
export const UpdatePromoBodySchema = Type.Object({
  validTo: Type.Optional(Type.String({ format: "date-time" })),
  maxRedemptions: Type.Optional(Type.Integer({ minimum: 1 })),
});

// ── response DTOs (§4.4) — reused by the OpenAPI enrichment registry ─────────────────────────────────────

const MeterCatalogDto = Type.Object({
  eventType: Type.String(),
  label: Type.String(),
  inclusiveQuantity: Type.Integer(),
  overageUnitPriceCents: Type.Integer(),
  billingAggregation: Type.String(),
});
export const PlanCatalogResponseDto = Type.Object({
  slug: Type.String(),
  name: Type.String(),
  description: strNull(),
  tier: PlanTierLit,
  cadence: CadenceLit,
  basePriceCents: Type.Integer(),
  currencyCode: Type.String(),
  trialPeriodDays: Type.Integer(),
  meters: Type.Array(MeterCatalogDto),
});
export const PlanCatalogListResponseDto = Type.Array(PlanCatalogResponseDto);

export const SubscriptionResponseDto = Type.Object({
  id: uuid(),
  organizationId: uuid(),
  planSlug: Type.String(),
  planName: Type.String(),
  status: SubscriptionStatusLit,
  trialEndsAt: isoNull(),
  currentPeriodStart: isoNull(),
  currentPeriodEnd: isoNull(),
  cancelAtPeriodEnd: Type.Boolean(),
  canceledAt: isoNull(),
  defaultPaymentMethodLast4: strNull(),
  defaultPaymentMethodBrand: strNull(),
  defaultPaymentMethodExpiresAt: dateNull(),
  dunningStage: DunningStageLit,
});
export const SubscriptionAdminResponseDto = Type.Intersect([
  SubscriptionResponseDto,
  Type.Object({
    planTier: PlanTierLit,
    stripeSubscriptionId: strNull(),
    startedAt: Type.String({ format: "date-time" }),
    // §5.2 — org display name (M2 `OrganizationReader` seam, M35A-T03); "" when unresolved.
    organizationName: Type.String(),
  }),
]);

export const PaymentMethodDto = Type.Object({
  id: uuid(),
  kind: Type.String(),
  brand: strNull(),
  last4: strNull(),
  expiresAt: dateNull(),
  isDefault: Type.Boolean(),
  isActive: Type.Boolean(),
});
export const PaymentMethodListResponseDto = Type.Array(PaymentMethodDto);
export const SetupIntentResponseDto = Type.Object({
  clientSecret: strNull(),
  status: Type.Union([Type.Literal("pending"), Type.Literal("ready")]),
});

export const InvoiceListItemDto = Type.Object({
  id: uuid(),
  invoiceNumber: strNull(),
  status: InvoiceStatusLit,
  totalCents: Type.Integer(),
  currencyCode: Type.String(),
  periodStart: isoNull(),
  periodEnd: isoNull(),
  issuedAt: isoNull(),
  dueAt: isoNull(),
  paidAt: isoNull(),
});
export const InvoiceLineDto = Type.Object({
  id: uuid(),
  kind: Type.String(),
  description: Type.String(),
  quantity: Type.Integer(),
  unitAmountCents: Type.Integer(),
  totalCents: Type.Integer(),
});
export const InvoiceDetailDto = Type.Intersect([
  InvoiceListItemDto,
  Type.Object({
    subtotalCents: Type.Integer(),
    taxCents: Type.Integer(),
    amountPaidCents: Type.Integer(),
    lines: Type.Array(InvoiceLineDto),
  }),
]);
export const RedirectUrlDto = Type.Object({ url: strNull() });

const cursorPage = (item: TSchema) =>
  Type.Object({ items: Type.Array(item), nextCursor: strNull(), hasMore: Type.Boolean() });
export const InvoiceListResponseDto = cursorPage(InvoiceListItemDto);

export const UsageMeterDto = Type.Object({
  eventType: Type.String(),
  label: Type.String(),
  totalQuantity: Type.Integer(),
  inclusiveQuantity: Type.Integer(),
  overageQuantity: Type.Integer(),
  overageUnitPriceCents: Type.Integer(),
  projectedOverageCostCents: Type.Integer(),
  thresholdState: Type.Union([
    Type.Literal("ok"),
    Type.Literal("warning"),
    Type.Literal("breached"),
  ]),
});
export const UsageCurrentResponseDto = Type.Object({
  periodStart: Type.String({ format: "date-time" }),
  periodEnd: Type.String({ format: "date-time" }),
  meters: Type.Array(UsageMeterDto),
});
export const UsagePeriodDto = Type.Object({
  periodStart: Type.String({ format: "date-time" }),
  periodEnd: Type.String({ format: "date-time" }),
  totalQuantity: Type.Integer(),
  inclusiveQuantity: Type.Integer(),
  overageQuantity: Type.Integer(),
});
export const UsageHistoryResponseDto = cursorPage(UsagePeriodDto);

export const BillingStatusDto = Type.Object({
  status: Type.String(),
  isBlockedByBilling: Type.Boolean(),
  dunningStage: Type.String(),
  daysUntilSuspension: intNull(),
  hasValidPaymentMethod: Type.Boolean(),
  paymentMethodExpiresAt: dateNull(),
});

export const PlanAdminDto = Type.Intersect([
  PlanCatalogResponseDto,
  Type.Object({
    id: uuid(),
    isActive: Type.Boolean(),
    deprecatedAt: isoNull(),
    stripeProductId: strNull(),
    stripePriceId: strNull(),
  }),
]);
export const PlanAdminListResponseDto = Type.Array(PlanAdminDto);
export const MeterAdminDto = Type.Object({
  id: uuid(),
  planId: uuid(),
  eventType: Type.String(),
  label: Type.String(),
  inclusiveQuantity: Type.Integer(),
  overageUnitPriceCents: Type.Integer(),
  billingAggregation: Type.String(),
  warningThresholdPercent: Type.Integer(),
});
export const SubscriptionAdminListResponseDto = cursorPage(SubscriptionAdminResponseDto);

export const RefundDto = Type.Object({
  id: uuid(),
  organizationId: uuid(),
  // §5.2 — org display name (M2 `OrganizationReader` seam, M35A-T03); "" when unresolved.
  organizationName: Type.String(),
  invoiceId: uuid(),
  amountCents: Type.Integer(),
  kind: Type.Union([Type.Literal("full"), Type.Literal("partial"), Type.Literal("credit_only")]),
  reasonCode: Type.String(),
  status: Type.Union([
    Type.Literal("requested"),
    Type.Literal("approved"),
    Type.Literal("denied"),
    Type.Literal("executed_success"),
    Type.Literal("executed_failed"),
  ]),
  requestedByMembershipId: uuid(),
  requestedAt: Type.String({ format: "date-time" }),
  approvedByMembershipId: Type.Union([uuid(), Type.Null()]),
  approvedAt: isoNull(),
  deniedReason: strNull(),
  executedAt: isoNull(),
  stripeRefundId: strNull(),
});
export const RefundListResponseDto = cursorPage(RefundDto);

export const PromoDto = Type.Object({
  id: uuid(),
  code: Type.String(),
  kind: Type.String(),
  percentOff: intNull(),
  fixedOffCents: intNull(),
  duration: Type.String(),
  durationInMonths: intNull(),
  validFrom: isoNull(),
  validTo: isoNull(),
  maxRedemptions: intNull(),
  redemptionCount: Type.Integer(),
  isActive: Type.Boolean(),
});
export const PromoListResponseDto = Type.Array(PromoDto);
export const PromoApplicationDto = Type.Object({
  applicationId: uuid(),
  subscriptionId: uuid(),
  promoCode: Type.String(),
  applied: Type.Boolean(),
});
export const DunningDto = Type.Object({
  subscriptionId: uuid(),
  stage: DunningStageLit,
  enteredAt: Type.String({ format: "date-time" }),
  nextAttemptAt: isoNull(),
});
export const DunningListItemDto = Type.Object({
  subscriptionId: uuid(),
  organizationId: uuid(),
  // §5.2 — org display name (M2 `OrganizationReader` seam, M35A-T03); "" when unresolved.
  organizationName: Type.String(),
  planName: Type.String(),
  subscriptionStatus: SubscriptionStatusLit,
  stage: DunningStageLit,
  enteredAt: Type.String({ format: "date-time" }),
  nextAttemptAt: isoNull(),
});
export const DunningListResponseDto = cursorPage(DunningListItemDto);
export const RevenueSnapshotDto = Type.Object({
  id: uuid(),
  snapshotMonth: Type.String(),
  mrrCents: Type.Integer(),
  arrCents: Type.Integer(),
  newMrrCents: Type.Integer(),
  expansionMrrCents: Type.Integer(),
  contractionMrrCents: Type.Integer(),
  churnMrrCents: Type.Integer(),
  activeSubscriptions: Type.Integer(),
  trialingSubscriptions: Type.Integer(),
  pastDueSubscriptions: Type.Integer(),
  computedAt: Type.String({ format: "date-time" }),
});
export const RevenueSnapshotListResponseDto = cursorPage(RevenueSnapshotDto);
export const CurrentRevenueResponseDto = Type.Object({
  mrrCents: Type.Integer(),
  arrCents: Type.Integer(),
  activeSubscriptions: Type.Integer(),
  asOf: Type.String({ format: "date-time" }),
});
export const WebhookReceiptDto = Type.Object({
  stripeEventId: Type.String(),
  eventType: Type.String(),
  receivedAt: Type.String({ format: "date-time" }),
  processedAt: isoNull(),
  processingAttemptCount: Type.Integer(),
  derivedOrganizationId: strNull(),
});
export const WebhookReceiptListResponseDto = cursorPage(WebhookReceiptDto);
export const AckResponseDto = Type.Object({ ok: Type.Boolean() });

// ── validate helper ─────────────────────────────────────────────────────────────────────────────────────

/** Convert + validate `raw` against `schema`; a failure throws M1's VALIDATION_FAILED envelope. */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  const converted = Value.Convert(schema, raw ?? {});
  if (!Value.Check(schema, converted)) {
    const first = [...Value.Errors(schema, converted)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return converted as Static<T>;
}
