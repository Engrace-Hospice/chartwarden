// @wardenx/types — Module 35 (Subscription Billing / Stripe) leaf contracts (M35-T01).
//
// Per ADR-0005 D1/D3 the cross-module CONTRACTS live in this leaf package: the M35 spec's references to
// `packages/subscription-billing/src/seams/**` resolve their TYPE surface HERE, so the downstream
// consumers (M33 platform-ops revenue dashboard, M34 tenant SaaS console, M28/M29/M32 quota checks, M36
// alerts, M2 org-lifecycle) import them with NO `dependsOn` edge (ADR-0025 keeps M34↔M35 seam-based both
// ways). The `@wardenx/subscription-billing` package IMPLEMENTS these interfaces; it never re-declares the
// wire types, and it takes a `@wardenx/types` edge for them.
//
// SCOPE (authority: architecture/module-manifest.ts wins over the spec's §2.1 ERD — ADR-0005). The
// manifest owns 21 tables; this leaf ships the concrete type foundation for the module's forward-facing
// wire surface: the §3.3 pgEnum value mirrors, the owned-table-name set, the §4.11/§4.12 outbox taxonomy
// (published + subscribed), the §4.11 payload shapes, and the §4.5/§4.6 seam interfaces. The pure §2
// domain kernels (state-transition maps, validation predicates, audit-posture hints) live in the
// `@wardenx/subscription-billing` package — NOT here; this file is type-only and importable by everyone.
//
// PHI/SECRETS boundary (D3/D8/§8.4): every wire shape here is PHI-free and secret-free by construction —
// ids are uuids or opaque Stripe ids, never `patient_id` / name / MRN; the pseudonym tables surface only
// the 32-hex HMAC digest, never the raw subject; Stripe secret keys / card PANs never appear in any type.
//
// NAMING: exported symbols carry a billing-domain prefix (`Subscription`/`Invoice`/`Plan`/`Usage`/
// `Dunning`/`Refund`/`Promo`/`Stripe`/`M35`). `@wardenx/types` is re-exported wholesale from `./index.ts`,
// so a bare `Status` / `Tier` / `Cadence` would be a TS2308 collision the day another module wants the
// same word (the M14 `IdgDecisionPayload` precedent).

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal use only so the
// package surface stays unambiguous under `export *` — re-exporting would be a TS2308 collision) ───────
import type { OrgId, PatientId } from "./admission";
import type { IsoInstant, MembershipId } from "./care-plan";

// ── M35-owned id aliases (mirror the §3.3 uuid PKs of the 21 owned tables; packages/types cannot import
// @wardenx/db) ─────────────────────────────────────────────────────────────────────────────────────────
export type PlanId = string;
export type PlanMeterId = string;
export type SubscriptionId = string;
export type SubscriptionStateHistoryId = string;
export type PaymentMethodId = string;
export type InvoiceId = string;
export type InvoiceLineId = string;
export type UsageEventId = string;
export type UsagePeriodAggregateId = string;
export type PatientActivePeriodId = string;
export type UserActivePeriodId = string;
export type StripeWebhookEventId = string;
export type StripeApiCallAuditId = string;
export type DunningStateId = string;
export type RevenueRecognitionSnapshotId = string;
export type PromoCodeId = string;
export type PromoCodeApplicationId = string;
export type RefundId = string;
export type PatientPseudonymKeyId = string;
export type PlatformRetainedInvoiceId = string;
export type PlatformRetainedInvoiceLineId = string;
/** A calendar-month bucket key in `YYYY-MM` form (revenue snapshots, active-period aggregation). */
export type BillingYearMonth = string;
/** A 32-char lowercase-hex HMAC-SHA256 digest — the ONLY subject identifier stored in the pseudonym
 *  tables (§2.3 CHECK `^[a-f0-9]{32}$`). The raw `patient_id` / `membership_id` never lands here. */
export type BillingPseudonym = string;

// ── §3.3 pgEnum value mirrors (kept in lock-step with `@wardenx/subscription-billing`'s `enums.ts` and the
// `packages/db/src/schema/subscription-billing/*` pgEnums the T02 migration lands) ─────────────────────

/** §3.3 `plan_tier` — the plan grade (platform-shared catalog, D11). */
export type PlanTier = "starter" | "professional" | "enterprise";

/** §3.3 `billing_cadence` — the base-price billing period. */
export type BillingCadence = "monthly" | "annual";

/** §3.3 `subscription_status` — the D7 state machine (`paused` is the lateral state). */
export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "at_risk"
  | "suspended"
  | "canceled"
  | "paused";

/** §3.3 `dunning_stage` — the D7 dunning ladder (`none`/`resolved` bracket the active sequence). */
export type DunningStage =
  | "none"
  | "day_1"
  | "day_7"
  | "day_14"
  | "day_21"
  | "day_28_suspend"
  | "day_60_cancel"
  | "resolved";

/** §3.3 `invoice_status` — mirrors the Stripe invoice lifecycle (M35 never authors invoices — D). */
export type InvoiceStatus = "draft" | "open" | "paid" | "void" | "uncollectible";

/** §3.3 `invoice_line_kind` — the kind of a single Stripe invoice line item. */
export type InvoiceLineKind =
  | "subscription"
  | "metered"
  | "one_time"
  | "tax"
  | "discount"
  | "credit"
  | "proration";

/** §3.3 `refund_status` — the D16 four-stage refund workflow terminal + interim states. */
export type RefundStatus =
  | "requested"
  | "approved"
  | "denied"
  | "executed_success"
  | "executed_failed";

/** §3.3 `refund_kind` — the shape of a refund against an invoice. */
export type RefundKind = "full" | "partial" | "credit_only";

/** §3.3 `promo_kind` — the discount computation of a promo code. */
export type PromoKind = "percent_off" | "amount_off";

/** §3.3 `promo_duration` — how long a Stripe coupon applies once redeemed. */
export type PromoDuration = "once" | "repeating" | "forever";

/** §3.3 `payment_method_kind` — the Stripe PaymentMethod family (metadata only; no PAN). */
export type PaymentMethodKind = "card" | "us_bank_account" | "sepa_debit" | "other";

/** §3.3 `usage_event_type` — the metered dimensions (the seam's `meter` argument). */
export type UsageEventType =
  | "active_patient"
  | "active_user"
  | "claim_submitted_medicare"
  | "claim_submitted_medicaid"
  | "ai_tokens_consumed"
  | "fhir_egress_request"
  | "hl7_message_inbound"
  | "hl7_message_outbound";

/** §3.3 `usage_event_source_module` — which module emitted a usage event (idempotency key component). */
export type UsageEventSourceModule = "m1" | "m2" | "m5" | "m23" | "m24" | "m28" | "m29" | "m32";

/** §3.3 `inactivity_reason` — why a patient/user active-period row flipped to inactive. */
export type BillingInactivityReason = "discharged" | "died" | "revoked" | "transferred";

/** §2.2 the meter's Stripe billing-aggregation strategy (`plan_meter.billing_aggregation`). */
export type BillingAggregation = "sum" | "last" | "count";

// ── §3.3 owned tables + §13 manifest patch ─────────────────────────────────────────────────────────────

/** The 21 §3.3 owned tables (the manifest `ownedTables` set for M35, incl. the M35-F06 platform-retention
 *  pair). The manifest is authoritative (ADR-0005). Tenant-scoped vs platform-shared posture is in
 *  {@link M35_TENANT_SCOPED_TABLES}. */
export type M35TableName =
  | "plan"
  | "plan_meter"
  | "subscription"
  | "subscription_state_history"
  | "payment_method"
  | "invoice"
  | "invoice_line"
  | "usage_event"
  | "usage_period_aggregate"
  | "patient_active_period"
  | "user_active_period"
  | "stripe_webhook_event"
  | "stripe_api_call_audit"
  | "dunning_state"
  | "revenue_recognition_snapshot"
  | "promo_code"
  | "promo_code_application"
  | "refund"
  | "patient_pseudonym_key"
  | "platform_retained_invoice"
  | "platform_retained_invoice_line";

// ── §4.11 outbox event names (the canonical wire identifiers the dispatcher + arch:gaps validate) ──────

/** The full §4.11 M35 outbox taxonomy, in canonical `m35.<resource>.<verb>` form. Publication wiring
 *  lands with the lifecycle services (M35-T03/T05) and the routes/outbox (M35-T06). */
export const M35_EVENT_NAMES = [
  "m35.subscription.created",
  "m35.subscription.activated",
  "m35.subscription.status_changed",
  "m35.subscription.plan_changed",
  "m35.subscription.canceled",
  "m35.subscription.paused",
  "m35.subscription.resumed",
  "m35.subscription.suspended",
  "m35.dunning.entered_stage",
  "m35.dunning.resolved",
  "m35.invoice.created",
  "m35.invoice.paid",
  "m35.invoice.payment_failed",
  "m35.invoice.voided",
  "m35.invoice.uncollectible",
  "m35.payment_method.added",
  "m35.payment_method.expiring_soon",
  "m35.payment_method.expired",
  "m35.payment_method.removed",
  "m35.usage.period_closed",
  "m35.usage.overage_threshold_warning",
  "m35.usage.overage_threshold_breached",
  "m35.refund.requested",
  "m35.refund.approved",
  "m35.refund.executed",
  "m35.refund.failed",
  "m35.promo.applied",
  "m35.promo.expired",
  "m35.stripe.webhook_received",
  "m35.stripe.api_call_failed",
  "m35.tenant.billing_blocked",
  "m35.revenue.monthly_snapshot_computed",
] as const;

export type M35EventName = (typeof M35_EVENT_NAMES)[number];

/**
 * The §4.12 upstream events M35 subscribes to.
 *
 * This used to say "(verified as live by `validateSeams()` at boot)". It is not and never was:
 * `validateSeams()` validates the M1 SEAM registry and has no knowledge of outbox event names. Rule 6 of
 * `check-outbox-bindings.ts` (F-094/#205) is the first thing to check it, and found that HALF of what this
 * list named does not exist: **M2 contributes no event catalog to the boot dispatcher** — there is no
 * `M2_OUTBOX_EVENTS` — so the four `m2.*` topics the §4.12 seat-count and suspension logic are specified
 * against have no producer. That absence is now resolved (#205 — M2 catalogues 16 identity-lifecycle
 * events).
 *
 * F-142 (#248) corrected the OTHER half of this list, which was wrong in the opposite direction: it named
 * `m32.tenant_opt_in.*`/`m32.capability.invoked`/`m34.tenant.provisioned`/`.offboarding_initiated` as
 * subscribed, but M35's own D21 (locked, exhaustive — "8 inbound subscriptions") never names any of the
 * five, and D24 states the M32/M34 relationships are both SEAMS (`UsageMeteringIngest.ingest` called INTO
 * M35; `OnboardingStatusProvider` consumed FROM M34 as a forward-seam deny-stub), never outbox pushes. This
 * list is now exactly D21's 8 — all catalogued and declaring `m35` except the two M5 events D21 itself
 * marks record-only-target (`m5.patient.created`/`.status_changed` — M5 has refused that coupling; see
 * `outbox-subscription-exceptions.ts`).
 *
 * M35 still has no `consumers/` directory, so all 8 are intents rather than live bindings.
 */
export const M35_SUBSCRIBED_EVENT_NAMES = [
  "m2.organization.activated",
  "m2.organization.suspended",
  "m2.organization.closed",
  "m2.session.created",
  "m5.patient.created",
  "m5.patient.status_changed",
  "m5.patient.deceased",
  "m5.patient.merged",
] as const;

export type M35SubscribedEventName = (typeof M35_SUBSCRIBED_EVENT_NAMES)[number];

// ── §4.11 outbox payloads (PHI-free; ids are uuids or Stripe ids — §8.4) ───────────────────────────────

export interface M35SubscriptionCreatedPayload {
  readonly subscriptionId: SubscriptionId;
  readonly organizationId: OrgId;
  readonly planSlug: string;
  readonly startedAt: IsoInstant;
}

export interface M35SubscriptionActivatedPayload {
  readonly subscriptionId: SubscriptionId;
  readonly organizationId: OrgId;
  readonly activatedAt: IsoInstant;
}

export interface M35SubscriptionStatusChangedPayload {
  readonly subscriptionId: SubscriptionId;
  readonly organizationId: OrgId;
  readonly fromStatus: SubscriptionStatus;
  readonly toStatus: SubscriptionStatus;
  readonly transitionedAt: IsoInstant;
  readonly reasonCode: string;
}

export interface M35SubscriptionPlanChangedPayload {
  readonly subscriptionId: SubscriptionId;
  readonly organizationId: OrgId;
  readonly fromPlanSlug: string;
  readonly toPlanSlug: string;
  readonly prorationBehavior: SubscriptionProrationBehavior;
  readonly effectiveAt: IsoInstant;
}

export interface M35SubscriptionCanceledPayload {
  readonly subscriptionId: SubscriptionId;
  readonly organizationId: OrgId;
  readonly canceledAt: IsoInstant;
  readonly reasonCode: string;
  readonly atPeriodEnd: boolean;
}

export interface M35SubscriptionPausedPayload {
  readonly subscriptionId: SubscriptionId;
  readonly organizationId: OrgId;
  readonly pausedAt: IsoInstant;
  readonly pausedUntil: IsoInstant | null;
}

export interface M35SubscriptionResumedPayload {
  readonly subscriptionId: SubscriptionId;
  readonly organizationId: OrgId;
  readonly resumedAt: IsoInstant;
}

export interface M35SubscriptionSuspendedPayload {
  readonly subscriptionId: SubscriptionId;
  readonly organizationId: OrgId;
  readonly suspendedAt: IsoInstant;
  readonly reasonCode: string;
  readonly lastSuccessfulPaymentAt: IsoInstant | null;
}

export interface M35DunningEnteredStagePayload {
  readonly subscriptionId: SubscriptionId;
  readonly organizationId: OrgId;
  readonly fromStage: DunningStage;
  readonly toStage: DunningStage;
  readonly enteredAt: IsoInstant;
  readonly nextAttemptAt: IsoInstant | null;
}

export interface M35DunningResolvedPayload {
  readonly subscriptionId: SubscriptionId;
  readonly organizationId: OrgId;
  readonly resolvedAt: IsoInstant;
  readonly lastStage: DunningStage;
}

export interface M35InvoiceCreatedPayload {
  readonly invoiceId: InvoiceId;
  readonly organizationId: OrgId;
  readonly stripeInvoiceId: string;
  readonly totalCents: number;
  readonly periodStart: IsoInstant | null;
  readonly periodEnd: IsoInstant | null;
}

export interface M35InvoicePaidPayload {
  readonly invoiceId: InvoiceId;
  readonly organizationId: OrgId;
  readonly paidAt: IsoInstant;
  readonly amountPaidCents: number;
}

export interface M35InvoicePaymentFailedPayload {
  readonly invoiceId: InvoiceId;
  readonly organizationId: OrgId;
  readonly failureCode: string;
  readonly attemptCount: number;
  readonly nextAttemptAt: IsoInstant | null;
}

export interface M35InvoiceVoidedPayload {
  readonly invoiceId: InvoiceId;
  readonly organizationId: OrgId;
  readonly voidedAt: IsoInstant;
  readonly voidedByMembershipId: MembershipId | null;
}

export interface M35InvoiceUncollectiblePayload {
  readonly invoiceId: InvoiceId;
  readonly organizationId: OrgId;
  readonly markedAt: IsoInstant;
}

export interface M35PaymentMethodAddedPayload {
  readonly paymentMethodId: PaymentMethodId;
  readonly organizationId: OrgId;
  readonly kind: PaymentMethodKind;
  readonly isDefault: boolean;
}

export interface M35PaymentMethodExpiringSoonPayload {
  readonly paymentMethodId: PaymentMethodId;
  readonly organizationId: OrgId;
  readonly expiresAt: IsoInstant;
  readonly daysUntilExpiry: number;
}

export interface M35PaymentMethodExpiredPayload {
  readonly paymentMethodId: PaymentMethodId;
  readonly organizationId: OrgId;
  readonly expiredAt: IsoInstant;
}

export interface M35PaymentMethodRemovedPayload {
  readonly paymentMethodId: PaymentMethodId;
  readonly organizationId: OrgId;
  readonly deactivatedAt: IsoInstant;
}

export interface M35UsagePeriodClosedPayload {
  readonly subscriptionId: SubscriptionId;
  readonly organizationId: OrgId;
  readonly periodStart: IsoInstant;
  readonly periodEnd: IsoInstant;
  readonly meterTotals: ReadonlyArray<{ eventType: UsageEventType; totalQuantity: number }>;
}

export interface M35UsageOverageWarningPayload {
  readonly subscriptionId: SubscriptionId;
  readonly organizationId: OrgId;
  readonly eventType: UsageEventType;
  readonly totalQuantity: number;
  readonly inclusiveQuantity: number;
  readonly projectedOverageCents: number;
}

export interface M35UsageOverageBreachedPayload {
  readonly subscriptionId: SubscriptionId;
  readonly organizationId: OrgId;
  readonly eventType: UsageEventType;
  readonly totalQuantity: number;
  readonly inclusiveQuantity: number;
}

export interface M35RefundRequestedPayload {
  readonly refundId: RefundId;
  readonly organizationId: OrgId;
  readonly invoiceId: InvoiceId;
  readonly amountCents: number;
  readonly requestedByMembershipId: MembershipId;
  readonly reasonCode: string;
}

export interface M35RefundApprovedPayload {
  readonly refundId: RefundId;
  readonly organizationId: OrgId;
  readonly approvedByMembershipId: MembershipId;
  readonly approvedAt: IsoInstant;
}

export interface M35RefundExecutedPayload {
  readonly refundId: RefundId;
  readonly organizationId: OrgId;
  readonly executedAt: IsoInstant;
  readonly amountCents: number;
  readonly stripeRefundId: string;
}

export interface M35RefundFailedPayload {
  readonly refundId: RefundId;
  readonly organizationId: OrgId;
  readonly failedAt: IsoInstant;
  readonly stripeFailureCode: string;
}

export interface M35PromoAppliedPayload {
  readonly applicationId: PromoCodeApplicationId;
  readonly organizationId: OrgId;
  readonly subscriptionId: SubscriptionId;
  readonly promoCode: string;
  readonly appliedByMembershipId: MembershipId;
}

export interface M35PromoExpiredPayload {
  readonly applicationId: PromoCodeApplicationId;
  readonly organizationId: OrgId;
  readonly expiredAt: IsoInstant;
}

export interface M35StripeWebhookReceivedPayload {
  readonly stripeEventId: string;
  readonly eventType: string;
  readonly receivedAt: IsoInstant;
  readonly derivedOrganizationId: OrgId | null;
}

export interface M35StripeApiCallFailedPayload {
  readonly apiCallAuditId: StripeApiCallAuditId;
  readonly operation: string;
  readonly organizationId: OrgId | null;
  readonly attemptIndex: number;
  readonly errorText: string;
}

export interface M35TenantBillingBlockedPayload {
  readonly organizationId: OrgId;
  readonly subscriptionId: SubscriptionId;
  readonly blockedAt: IsoInstant;
  readonly dunningStage: DunningStage;
}

export interface M35RevenueMonthlySnapshotComputedPayload {
  readonly snapshotId: RevenueRecognitionSnapshotId;
  readonly snapshotMonth: BillingYearMonth;
  readonly mrrCents: number;
  readonly arrCents: number;
  readonly activeSubscriptions: number;
}

/** Name → payload map for the §4.11 taxonomy (the dispatcher's compile-time contract). */
export interface M35EventPayloadMap {
  "m35.subscription.created": M35SubscriptionCreatedPayload;
  "m35.subscription.activated": M35SubscriptionActivatedPayload;
  "m35.subscription.status_changed": M35SubscriptionStatusChangedPayload;
  "m35.subscription.plan_changed": M35SubscriptionPlanChangedPayload;
  "m35.subscription.canceled": M35SubscriptionCanceledPayload;
  "m35.subscription.paused": M35SubscriptionPausedPayload;
  "m35.subscription.resumed": M35SubscriptionResumedPayload;
  "m35.subscription.suspended": M35SubscriptionSuspendedPayload;
  "m35.dunning.entered_stage": M35DunningEnteredStagePayload;
  "m35.dunning.resolved": M35DunningResolvedPayload;
  "m35.invoice.created": M35InvoiceCreatedPayload;
  "m35.invoice.paid": M35InvoicePaidPayload;
  "m35.invoice.payment_failed": M35InvoicePaymentFailedPayload;
  "m35.invoice.voided": M35InvoiceVoidedPayload;
  "m35.invoice.uncollectible": M35InvoiceUncollectiblePayload;
  "m35.payment_method.added": M35PaymentMethodAddedPayload;
  "m35.payment_method.expiring_soon": M35PaymentMethodExpiringSoonPayload;
  "m35.payment_method.expired": M35PaymentMethodExpiredPayload;
  "m35.payment_method.removed": M35PaymentMethodRemovedPayload;
  "m35.usage.period_closed": M35UsagePeriodClosedPayload;
  "m35.usage.overage_threshold_warning": M35UsageOverageWarningPayload;
  "m35.usage.overage_threshold_breached": M35UsageOverageBreachedPayload;
  "m35.refund.requested": M35RefundRequestedPayload;
  "m35.refund.approved": M35RefundApprovedPayload;
  "m35.refund.executed": M35RefundExecutedPayload;
  "m35.refund.failed": M35RefundFailedPayload;
  "m35.promo.applied": M35PromoAppliedPayload;
  "m35.promo.expired": M35PromoExpiredPayload;
  "m35.stripe.webhook_received": M35StripeWebhookReceivedPayload;
  "m35.stripe.api_call_failed": M35StripeApiCallFailedPayload;
  "m35.tenant.billing_blocked": M35TenantBillingBlockedPayload;
  "m35.revenue.monthly_snapshot_computed": M35RevenueMonthlySnapshotComputedPayload;
}

// ── §2.2 / §4.5 shared domain value shapes (surfaced by the published seams below) ─────────────────────

/** §4.13/D3 the proration behaviors a plan change may request (the ABAC `plan_change_within_period_grace`
 *  predicate gates `always_invoice` outside the 7-day grace window). */
export type SubscriptionProrationBehavior = "create_prorations" | "none" | "always_invoice";

/** §4.5 `SubscriptionStateProvider` DTO — the subscription header every consumer reads (M33/M34). */
export interface SubscriptionState {
  readonly id: SubscriptionId;
  readonly organizationId: OrgId;
  readonly planSlug: string;
  readonly planTier: PlanTier;
  readonly status: SubscriptionStatus;
  readonly currentPeriodStart: IsoInstant | null;
  readonly currentPeriodEnd: IsoInstant | null;
  readonly trialEndsAt: IsoInstant | null;
  readonly cancelAtPeriodEnd: boolean;
}

/** §4.5 one `subscription_state_history` row (append-only; the D7 transition audit trail). */
export interface SubscriptionStateTransition {
  readonly id: SubscriptionStateHistoryId;
  readonly subscriptionId: SubscriptionId;
  readonly fromStatus: SubscriptionStatus | null;
  readonly toStatus: SubscriptionStatus;
  readonly transitionedAt: IsoInstant;
  readonly actorMembershipId: MembershipId | null;
  readonly reasonCode: string;
  readonly stripeEventId: string | null;
}

/** §4.5 `BillingStatusProvider` DTO — the billing-block gate M28/M29/M32/M34 read. */
export interface BillingStatus {
  readonly status: SubscriptionStatus;
  readonly isBlockedByBilling: boolean;
  readonly dunningStage: DunningStage;
  readonly daysUntilSuspension: number | null;
  readonly hasValidPaymentMethod: boolean;
  readonly paymentMethodExpiresAt: IsoInstant | null;
}

/** §4.5 one platform-shared plan catalog entry (public read; marketing + onboarding). */
export interface PlanCatalogEntry {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly tier: PlanTier;
  readonly cadence: BillingCadence;
  readonly basePriceCents: number;
  readonly currencyCode: string;
  readonly trialPeriodDays: number;
  readonly meters: ReadonlyArray<{
    readonly eventType: UsageEventType;
    readonly label: string;
    readonly inclusiveQuantity: number;
    readonly overageUnitPriceCents: number;
    readonly billingAggregation: BillingAggregation;
  }>;
}

/** §4.5 one monthly MRR/ARR snapshot (platform-shared; the M33 revenue dashboard reads these). */
export interface RevenueRecognitionSnapshot {
  readonly id: RevenueRecognitionSnapshotId;
  readonly snapshotMonth: BillingYearMonth;
  readonly mrrCents: number;
  readonly arrCents: number;
  readonly activeSubscriptions: number;
  readonly computedAt: IsoInstant;
}

/** §4.5 `UsageMeteringIngest` single-event input (PHI-free metadata is redactor-enforced at ingest). */
export interface UsageEventInput {
  readonly organizationId: OrgId;
  readonly eventType: UsageEventType;
  readonly quantity: number;
  readonly sourceModule: UsageEventSourceModule;
  readonly sourceEventId?: string;
  readonly metadataRedacted?: Record<string, string | number | boolean>;
  readonly recordedAt?: IsoInstant;
}

/** §4.5 one rejected event from a batch ingest (the redactor / validation refusal reason). */
export interface UsageEventRejection {
  readonly sourceEventId: string | null;
  readonly eventType: UsageEventType;
  readonly reason: string;
}

// ── §4.5 the six published seams (registered at boot via M1 SeamRegistry; validateSeams() enforces) ────

/** §4.5 read by M33 reporting + M34 SaaS console. */
export interface SubscriptionStateProvider {
  subscriptionForOrg(organizationId: OrgId): Promise<SubscriptionState | null>;
  stateHistoryForSubscription(
    subscriptionId: SubscriptionId,
    limit?: number,
  ): Promise<SubscriptionStateTransition[]>;
  subscriptionsForTenants(organizationIds: OrgId[]): Promise<Map<OrgId, SubscriptionState>>;
}

/** §4.5 the billing-block gate. `isQuotaAvailable` returns `{ ok: true }` in Phase 1 (no quotas). */
export interface BillingStatusProvider {
  statusForOrg(organizationId: OrgId): Promise<BillingStatus>;
  statusForOrgs(organizationIds: OrgId[]): Promise<Map<OrgId, BillingStatus>>;
  isQuotaAvailable(input: {
    organizationId: OrgId;
    meter: UsageEventType;
    requestedQuantity: number;
  }): Promise<{ ok: boolean; reason?: string }>;
}

/** §4.5 the usage-metering ingest seam consumed by M23/M24/M28/M29/M32. Idempotent on
 *  `(organizationId, sourceModule, sourceEventId)`; the redactor refuses PHI-shaped metadata. */
export interface UsageMeteringIngest {
  ingest(input: UsageEventInput): Promise<{ accepted: boolean; deduped: boolean; reason?: string }>;
  ingestBatch(input: { events: UsageEventInput[] }): Promise<{
    acceptedCount: number;
    dedupedCount: number;
    rejectedCount: number;
    rejections: UsageEventRejection[];
  }>;
}

/** §4.5 the pseudonymized active-patient counter (reads `patient_active_period`; reconciles vs M5). */
export interface PatientCounterProvider {
  activePatientCountForPeriod(input: {
    organizationId: OrgId;
    periodStart: IsoInstant;
    periodEnd: IsoInstant;
  }): Promise<number>;
}

/** §4.5 platform-shared revenue metrics (consumed by M33 for the platform-ops revenue dashboard). */
export interface RevenueMetricsProvider {
  currentMonthMrrCents(): Promise<number>;
  mrrSnapshotForMonth(yearMonth: BillingYearMonth): Promise<RevenueRecognitionSnapshot | null>;
  mrrSnapshotsForRange(input: {
    fromYearMonth: BillingYearMonth;
    toYearMonth: BillingYearMonth;
  }): Promise<RevenueRecognitionSnapshot[]>;
  subscriptionStatusCounts(): Promise<Record<SubscriptionStatus, number>>;
}

/** §4.5 the public (unauthenticated) plan catalog read (marketing pages + onboarding). */
export interface PlanCatalogReader {
  listActivePlans(): Promise<PlanCatalogEntry[]>;
  planBySlug(slug: string): Promise<PlanCatalogEntry | null>;
}

// ── §4.6 consumed forward-seam CONSUMER VIEWS (M35-T05) ─────────────────────────────────────────────────
// M35 consumes four upstream seams. `FhirGatewayMetricsProvider` (M28, §4.11 disclosure metrics) is ALREADY
// declared by its source module (`./fhir`) and M35 reads it as-is — it is NOT re-declared here (that would
// collide, TS2308). The remaining three source modules (M29/M32/M34) are Phase-1 placeholders that publish
// no leaf contract yet, so — following the M8→`EvvBracketResolver` / M28→`ClaimReader` forward-seam
// precedent — M35 carries the minimal CONSUMER VIEW its metering/billing paths need here. Each is registered
// into the M1 registry at boot as a fail-closed deny-stub (ADR-0025 mandates `OnboardingStatusProvider`'s
// interface live in `packages/types`); the real impls land when M29/M32/M34 lock. Leaf-safe (ids + counts).

/** §4.6 (M34) — the SaaS-onboarding billability gate M35 folds into `BillingStatusProvider`. Interim posture
 *  (ADR-0025): every org with `Organization.status='active'` is billable — a strictly SAFER default than the
 *  eventual M34-aware behavior, which will NARROW billability to "active AND onboarding-complete". */
export interface OnboardingStatusProvider {
  isBillableForOrg(organizationId: OrgId): Promise<{ billable: boolean; reason?: string }>;
}

/** §4.6 (M29) — the HL7 feed-health message counts M35 meters as `hl7_message` usage over a period. */
export interface ExternalInterfaceFeedHealth {
  readonly organizationId: OrgId;
  readonly inboundMessageCount: number;
  readonly outboundMessageCount: number;
  readonly periodStart: IsoInstant;
  readonly periodEnd: IsoInstant;
}

/** §4.6 (M29) — external-interface feed-health read (HL7 message counts), the M35 `hl7_message` meter input. */
export interface ExternalInterfaceMetricsProvider {
  feedHealthForOrg(input: {
    organizationId: OrgId;
    periodStart: IsoInstant;
    periodEnd: IsoInstant;
  }): Promise<ExternalInterfaceFeedHealth>;
}

/** §4.6 (M32) — the AI-token consumption M35 meters as `ai_token` usage (PHI-free aggregate token count). */
export interface AITokenMeterProvider {
  tokensConsumedForOrg(input: {
    organizationId: OrgId;
    periodStart: IsoInstant;
    periodEnd: IsoInstant;
  }): Promise<number>;
}

// ── §4.10 typed M36 alert taxonomy (the discriminated shape M35 emits to M36's AlertEmitter) ────────────

/** §4.10 the alert severity the M36 AlertEmitter routes on. */
export type M35AlertSeverity = "info" | "warn" | "critical";

/** §4.10 the recipient-resolver strategy for an alert rule (`dunning_recipient_resolver` is M35-new). */
export type M35AlertRecipientResolver =
  | "role_set"
  | "platform_role_set"
  | "dunning_recipient_resolver";

/** §4.10 one static alert-routing rule (the `M35_ALERT_RULES` table; `systemLocked` cannot be disabled). */
export interface M35AlertRule {
  readonly eventType: M35EventName;
  readonly severity: M35AlertSeverity;
  readonly recipientResolver: M35AlertRecipientResolver;
  readonly recipientArgs: { readonly roles?: readonly string[] };
  readonly systemLocked: boolean;
}
