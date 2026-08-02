// @wardenx/subscription-billing — §3.3 enum value tuples (M35-T01).
//
// These `as const` tuples are the RUNTIME source of truth for M35's enumerations: the T02 Drizzle
// `pgEnum(...)` definitions (in `packages/db/src/schema/subscription-billing/enums.ts`) seed from these
// exact arrays, and the §2 domain kernels iterate/validate against them. The TYPE mirrors live in the
// leaf `@wardenx/types` (edge-free for cross-module consumers); each tuple is `satisfies`-pinned to its
// leaf union here so drift between the two definition sites is a compile error, not a silent lie
// (the M30 "wire enum as Type.String()" precedent).

import type {
  BillingAggregation,
  BillingCadence,
  BillingInactivityReason,
  DunningStage,
  InvoiceLineKind,
  InvoiceStatus,
  PaymentMethodKind,
  PlanTier,
  PromoDuration,
  PromoKind,
  RefundKind,
  RefundStatus,
  SubscriptionStatus,
  UsageEventSourceModule,
  UsageEventType,
} from "@wardenx/types";

export const PLAN_TIERS = ["starter", "professional", "enterprise"] as const satisfies readonly PlanTier[];

export const BILLING_CADENCES = ["monthly", "annual"] as const satisfies readonly BillingCadence[];

export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "at_risk",
  "suspended",
  "canceled",
  "paused",
] as const satisfies readonly SubscriptionStatus[];

export const DUNNING_STAGES = [
  "none",
  "day_1",
  "day_7",
  "day_14",
  "day_21",
  "day_28_suspend",
  "day_60_cancel",
  "resolved",
] as const satisfies readonly DunningStage[];

export const INVOICE_STATUSES = [
  "draft",
  "open",
  "paid",
  "void",
  "uncollectible",
] as const satisfies readonly InvoiceStatus[];

export const INVOICE_LINE_KINDS = [
  "subscription",
  "metered",
  "one_time",
  "tax",
  "discount",
  "credit",
  "proration",
] as const satisfies readonly InvoiceLineKind[];

export const REFUND_STATUSES = [
  "requested",
  "approved",
  "denied",
  "executed_success",
  "executed_failed",
] as const satisfies readonly RefundStatus[];

export const REFUND_KINDS = ["full", "partial", "credit_only"] as const satisfies readonly RefundKind[];

export const PROMO_KINDS = ["percent_off", "amount_off"] as const satisfies readonly PromoKind[];

export const PROMO_DURATIONS = ["once", "repeating", "forever"] as const satisfies readonly PromoDuration[];

export const PAYMENT_METHOD_KINDS = [
  "card",
  "us_bank_account",
  "sepa_debit",
  "other",
] as const satisfies readonly PaymentMethodKind[];

export const USAGE_EVENT_TYPES = [
  "active_patient",
  "active_user",
  "claim_submitted_medicare",
  "claim_submitted_medicaid",
  "ai_tokens_consumed",
  "fhir_egress_request",
  "hl7_message_inbound",
  "hl7_message_outbound",
] as const satisfies readonly UsageEventType[];

export const USAGE_EVENT_SOURCE_MODULES = [
  "m1",
  "m2",
  "m5",
  "m23",
  "m24",
  "m28",
  "m29",
  "m32",
] as const satisfies readonly UsageEventSourceModule[];

export const BILLING_INACTIVITY_REASONS = [
  "discharged",
  "died",
  "revoked",
  "transferred",
] as const satisfies readonly BillingInactivityReason[];

export const BILLING_AGGREGATIONS = ["sum", "last", "count"] as const satisfies readonly BillingAggregation[];
