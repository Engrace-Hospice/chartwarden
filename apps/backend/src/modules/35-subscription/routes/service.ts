// apps/backend/src/modules/35-subscription/routes/service.ts — the M35 route-service CONTRACT (§4.1 tenant
// + §4.2 admin + §4.3 webhook surfaces) + the deliberately-narrowed view DTOs the route plugins return.
//
// Mirrors the M27 read/write-service precedent, folded into ONE interface (M35's read + write share a
// resource vocabulary): the route handlers compose over {@link M35RouteService}; the Drizzle backend
// (./service-drizzle) implements it under `withOrgContext` so RLS scopes every tenant statement to
// `app.org_id`. M35 carries NO PHI (§8.5); money is INTEGER CENTS; the outbound Stripe calls follow the
// §4.13 outbox-only path — a mutating route persists its local state row + emits an `m35.*` outbox event in
// the same transaction, and the (deferred) stripe-dispatcher worker drains the outbox and calls Stripe.
//
// DTO discipline (§8.5): Stripe secrets, card PANs, DEK refs, ciphertext, and pseudonym key material are
// NEVER projected onto a view. A payment-method view surfaces only the brand + last4 + expiry the tenant
// already sees on their statement.
import type { M35ReadActor, M35WriteActor } from "./actor";
import type { CursorPage } from "./concurrency";

// ── shared value unions (mirror the FROZEN @wardenx/db pgEnum value lists; schema wins on conflict) ──────

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "at_risk"
  | "suspended"
  | "canceled"
  | "paused";
export type DunningStage =
  | "none"
  | "day_1"
  | "day_7"
  | "day_14"
  | "day_21"
  | "day_28_suspend"
  | "day_60_cancel"
  | "resolved";
export type InvoiceStatus = "draft" | "open" | "paid" | "void" | "uncollectible";
export type RefundStatus = "requested" | "approved" | "denied" | "executed_success" | "executed_failed";
export type RefundKind = "full" | "partial" | "credit_only";
export type PlanTier = "starter" | "professional" | "enterprise";
export type BillingCadence = "monthly" | "annual";
export type ProrationBehavior = "create_prorations" | "always_invoice" | "none";
export type MeterThresholdState = "ok" | "warning" | "breached";

// ── tenant view DTOs ────────────────────────────────────────────────────────────────────────────────────

export interface PlanCatalogView {
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly tier: PlanTier;
  readonly cadence: BillingCadence;
  readonly basePriceCents: number;
  readonly currencyCode: string;
  readonly trialPeriodDays: number;
  readonly meters: readonly {
    readonly eventType: string;
    readonly label: string;
    readonly inclusiveQuantity: number;
    readonly overageUnitPriceCents: number;
    readonly billingAggregation: string;
  }[];
}

export interface SubscriptionView {
  readonly id: string;
  readonly organizationId: string;
  readonly planSlug: string;
  readonly planName: string;
  readonly status: SubscriptionStatus;
  readonly trialEndsAt: string | null;
  readonly currentPeriodStart: string | null;
  readonly currentPeriodEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly canceledAt: string | null;
  readonly defaultPaymentMethodLast4: string | null;
  readonly defaultPaymentMethodBrand: string | null;
  readonly defaultPaymentMethodExpiresAt: string | null;
  readonly dunningStage: DunningStage;
}

export interface PaymentMethodView {
  readonly id: string;
  readonly kind: string;
  readonly brand: string | null;
  readonly last4: string | null;
  readonly expiresAt: string | null;
  readonly isDefault: boolean;
  readonly isActive: boolean;
}

export interface SetupIntentView {
  /** The Stripe SetupIntent client_secret is provisioned by the dispatcher; the route returns a pending
   *  marker until it lands (the §4.13 outbox-only path). `null` while pending. */
  readonly clientSecret: string | null;
  readonly status: "pending" | "ready";
}

export interface InvoiceListItemView {
  readonly id: string;
  readonly invoiceNumber: string | null;
  readonly status: InvoiceStatus;
  readonly totalCents: number;
  readonly currencyCode: string;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly issuedAt: string | null;
  readonly dueAt: string | null;
  readonly paidAt: string | null;
}

export interface InvoiceDetailView extends InvoiceListItemView {
  readonly subtotalCents: number;
  readonly taxCents: number;
  readonly amountPaidCents: number;
  readonly lines: readonly {
    readonly id: string;
    readonly kind: string;
    readonly description: string;
    readonly quantity: number;
    readonly unitAmountCents: number;
    readonly totalCents: number;
  }[];
}

export interface RedirectUrlView {
  readonly url: string | null;
}

export interface UsageMeterView {
  readonly eventType: string;
  readonly label: string;
  readonly totalQuantity: number;
  readonly inclusiveQuantity: number;
  readonly overageQuantity: number;
  readonly overageUnitPriceCents: number;
  readonly projectedOverageCostCents: number;
  readonly thresholdState: MeterThresholdState;
}

export interface UsageCurrentView {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly meters: readonly UsageMeterView[];
}

export interface UsagePeriodView {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly totalQuantity: number;
  readonly inclusiveQuantity: number;
  readonly overageQuantity: number;
}

export interface BillingStatusView {
  readonly status: string;
  readonly isBlockedByBilling: boolean;
  readonly dunningStage: string;
  readonly daysUntilSuspension: number | null;
  readonly hasValidPaymentMethod: boolean;
  readonly paymentMethodExpiresAt: string | null;
}

// ── admin view DTOs ─────────────────────────────────────────────────────────────────────────────────────

export interface PlanAdminView extends PlanCatalogView {
  readonly id: string;
  readonly isActive: boolean;
  readonly deprecatedAt: string | null;
  readonly stripeProductId: string | null;
  readonly stripePriceId: string | null;
}

export interface MeterAdminView {
  readonly id: string;
  readonly planId: string;
  readonly eventType: string;
  readonly label: string;
  readonly inclusiveQuantity: number;
  readonly overageUnitPriceCents: number;
  readonly billingAggregation: string;
  readonly warningThresholdPercent: number;
}

export interface SubscriptionAdminView extends SubscriptionView {
  readonly planTier: PlanTier;
  readonly stripeSubscriptionId: string | null;
  readonly startedAt: string;
  /** The tenant's org display name, resolved via the M2 `OrganizationReader` seam (M35A-T03). Empty
   *  string when the reader is unbound / the org is not found — the console falls back to the raw id. */
  readonly organizationName: string;
}

export interface RefundView {
  readonly id: string;
  readonly organizationId: string;
  /** The tenant's org display name, resolved via the M2 `OrganizationReader` seam (M35A-T03). Empty
   *  string when the reader is unbound / the org is not found — the refund queue falls back to the raw id. */
  readonly organizationName: string;
  readonly invoiceId: string;
  readonly amountCents: number;
  readonly kind: RefundKind;
  readonly reasonCode: string;
  readonly status: RefundStatus;
  readonly requestedByMembershipId: string;
  readonly requestedAt: string;
  readonly approvedByMembershipId: string | null;
  readonly approvedAt: string | null;
  readonly deniedReason: string | null;
  readonly executedAt: string | null;
  readonly stripeRefundId: string | null;
}

export interface PromoView {
  readonly id: string;
  readonly code: string;
  readonly kind: string;
  readonly percentOff: number | null;
  readonly fixedOffCents: number | null;
  readonly duration: string;
  readonly durationInMonths: number | null;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly maxRedemptions: number | null;
  readonly redemptionCount: number;
  readonly isActive: boolean;
}

export interface PromoApplicationView {
  readonly applicationId: string;
  readonly subscriptionId: string;
  readonly promoCode: string;
  readonly applied: boolean;
}

export interface DunningView {
  readonly subscriptionId: string;
  readonly stage: DunningStage;
  readonly enteredAt: string;
  readonly nextAttemptAt: string | null;
}

/** One row of the §5.2 dunning screen: a subscription currently in an OPEN dunning stage, labelled with its
 *  org display name (M2 seam) + plan so the console can render the queue without a second round-trip. */
export interface DunningListItemView {
  readonly subscriptionId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly planName: string;
  readonly subscriptionStatus: SubscriptionStatus;
  readonly stage: DunningStage;
  readonly enteredAt: string;
  readonly nextAttemptAt: string | null;
}

/** Filters for the cross-tenant dunning list (§5.2). `stage` narrows to one open dunning stage. */
export interface DunningListFilters {
  readonly stage?: DunningStage;
}

export interface RevenueSnapshotView {
  readonly id: string;
  readonly snapshotMonth: string;
  readonly mrrCents: number;
  readonly arrCents: number;
  readonly newMrrCents: number;
  readonly expansionMrrCents: number;
  readonly contractionMrrCents: number;
  readonly churnMrrCents: number;
  readonly activeSubscriptions: number;
  readonly trialingSubscriptions: number;
  readonly pastDueSubscriptions: number;
  readonly computedAt: string;
}

export interface CurrentRevenueView {
  readonly mrrCents: number;
  readonly arrCents: number;
  readonly activeSubscriptions: number;
  readonly asOf: string;
}

export interface WebhookReceiptView {
  readonly stripeEventId: string;
  readonly eventType: string;
  readonly receivedAt: string;
  readonly processedAt: string | null;
  readonly processingAttemptCount: number;
  readonly derivedOrganizationId: string | null;
}

export interface AckView {
  readonly ok: boolean;
}

// ── argument shapes ─────────────────────────────────────────────────────────────────────────────────────

export interface CreateSubscriptionArgs {
  readonly planSlug: string;
  readonly paymentMethodId?: string;
  readonly promoCode?: string;
}
export interface ChangePlanArgs {
  readonly newPlanSlug: string;
  readonly prorationBehavior: ProrationBehavior;
}
export interface AttachPaymentMethodArgs {
  readonly stripePaymentMethodId: string;
  readonly setAsDefault?: boolean;
}
export interface CreatePlanArgs {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly tier: PlanTier;
  readonly cadence: BillingCadence;
  readonly basePriceCents: number;
  readonly currencyCode: string;
  readonly trialPeriodDays: number;
}
export interface UpdatePlanArgs {
  readonly name?: string;
  readonly description?: string;
  readonly basePriceCents?: number;
  readonly trialPeriodDays?: number;
}
export interface AddMeterArgs {
  readonly eventType: string;
  readonly label: string;
  readonly inclusiveQuantity: number;
  readonly overageUnitPriceCents: number;
  readonly billingAggregation: string;
  readonly warningThresholdPercent?: number;
}
export interface UpdateMeterArgs {
  readonly inclusiveQuantity?: number;
  readonly overageUnitPriceCents?: number;
  readonly warningThresholdPercent?: number;
}
export interface RequestRefundArgs {
  readonly invoiceId: string;
  readonly amountCents: number;
  readonly kind: RefundKind;
  readonly reasonCode: string;
  readonly reasonDetail: string;
}
export interface CreatePromoArgs {
  readonly code: string;
  readonly stripeCouponId: string;
  readonly stripePromotionCodeId: string;
  readonly kind: "percent_off" | "amount_off";
  readonly percentOff?: number;
  readonly fixedOffCents?: number;
  readonly duration: "once" | "repeating" | "forever";
  readonly durationInMonths?: number;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly maxRedemptions?: number;
}
export interface UpdatePromoArgs {
  readonly validTo?: string;
  readonly maxRedemptions?: number;
}
export interface AdminSubscriptionListFilters {
  readonly status?: SubscriptionStatus;
  readonly organizationId?: string;
}

/**
 * The single M35 route-service contract. Every method the §4.1/§4.2/§4.3 route plugins call. The tenant
 * methods take the server-assembled actor (org scope); the platform-ops methods take the write actor for
 * the acting membership + step-up, and are NOT org-scoped (they read/write across tenants under the
 * platform-ops role). `listActivePlans` takes no actor (the public marketing read).
 */
export interface M35RouteService {
  // ── tenant (§4.1) ──
  listActivePlans(): Promise<PlanCatalogView[]>;
  getSubscription(actor: M35ReadActor): Promise<SubscriptionView | null>;
  createSubscription(actor: M35WriteActor, args: CreateSubscriptionArgs): Promise<SubscriptionView>;
  changePlan(actor: M35WriteActor, args: ChangePlanArgs): Promise<SubscriptionView>;
  cancelSubscription(actor: M35WriteActor): Promise<SubscriptionView>;
  resumeSubscription(actor: M35WriteActor): Promise<SubscriptionView>;
  applyPromoTenant(actor: M35WriteActor, promoCode: string): Promise<PromoApplicationView>;
  listPaymentMethods(actor: M35ReadActor): Promise<PaymentMethodView[]>;
  createSetupIntent(actor: M35WriteActor): Promise<SetupIntentView>;
  attachPaymentMethod(actor: M35WriteActor, args: AttachPaymentMethodArgs): Promise<PaymentMethodView>;
  setDefaultPaymentMethod(actor: M35WriteActor, paymentMethodId: string): Promise<PaymentMethodView>;
  detachPaymentMethod(actor: M35WriteActor, paymentMethodId: string): Promise<AckView>;
  listInvoices(actor: M35ReadActor, cursor?: string, limit?: number): Promise<CursorPage<InvoiceListItemView>>;
  getInvoice(actor: M35ReadActor, invoiceId: string): Promise<InvoiceDetailView>;
  getInvoiceHostedUrl(actor: M35ReadActor, invoiceId: string): Promise<RedirectUrlView>;
  getInvoicePdfUrl(actor: M35ReadActor, invoiceId: string): Promise<RedirectUrlView>;
  getUsageCurrent(actor: M35ReadActor): Promise<UsageCurrentView>;
  getUsageHistory(actor: M35ReadActor, cursor?: string, limit?: number): Promise<CursorPage<UsagePeriodView>>;
  getBillingStatus(actor: M35ReadActor): Promise<BillingStatusView>;

  // ── platform-ops plans (§4.2) ──
  adminListPlans(): Promise<PlanAdminView[]>;
  adminGetPlan(planId: string): Promise<PlanAdminView>;
  adminCreatePlan(actor: M35WriteActor, args: CreatePlanArgs): Promise<PlanAdminView>;
  adminUpdatePlan(actor: M35WriteActor, planId: string, args: UpdatePlanArgs): Promise<PlanAdminView>;
  adminActivatePlan(actor: M35WriteActor, planId: string): Promise<PlanAdminView>;
  adminDeprecatePlan(actor: M35WriteActor, planId: string): Promise<PlanAdminView>;
  adminAddMeter(actor: M35WriteActor, planId: string, args: AddMeterArgs): Promise<MeterAdminView>;
  adminUpdateMeter(actor: M35WriteActor, planId: string, meterId: string, args: UpdateMeterArgs): Promise<MeterAdminView>;

  // ── platform-ops subscriptions (§4.2) ──
  adminListSubscriptions(filters: AdminSubscriptionListFilters, cursor?: string, limit?: number): Promise<CursorPage<SubscriptionAdminView>>;
  adminGetSubscription(subscriptionId: string): Promise<SubscriptionAdminView>;
  adminPauseSubscription(actor: M35WriteActor, subscriptionId: string, pausedUntil: string | null): Promise<SubscriptionAdminView>;
  adminResumeSubscription(actor: M35WriteActor, subscriptionId: string): Promise<SubscriptionAdminView>;
  adminCancelSubscription(actor: M35WriteActor, subscriptionId: string): Promise<SubscriptionAdminView>;
  adminApplyPromo(actor: M35WriteActor, subscriptionId: string, promoCode: string): Promise<PromoApplicationView>;
  adminRevokePromo(actor: M35WriteActor, subscriptionId: string, applicationId: string): Promise<AckView>;

  // ── platform-ops dunning (§4.2) ──
  adminListDunning(filters: DunningListFilters, cursor?: string, limit?: number): Promise<CursorPage<DunningListItemView>>;
  adminSkipDunningStage(actor: M35WriteActor, subscriptionId: string): Promise<DunningView>;
  adminResetDunning(actor: M35WriteActor, subscriptionId: string): Promise<DunningView>;

  // ── platform-ops refunds (§4.2) ──
  requestRefund(actor: M35WriteActor, args: RequestRefundArgs): Promise<RefundView>;
  approveRefund(actor: M35WriteActor, refundId: string): Promise<RefundView>;
  denyRefund(actor: M35WriteActor, refundId: string, reason: string): Promise<RefundView>;
  listRefunds(cursor?: string, limit?: number): Promise<CursorPage<RefundView>>;
  adminGetRefund(refundId: string): Promise<RefundView>;

  // ── platform-ops promos (§4.2) ──
  adminListPromos(): Promise<PromoView[]>;
  adminGetPromo(promoId: string): Promise<PromoView>;
  adminCreatePromo(actor: M35WriteActor, args: CreatePromoArgs): Promise<PromoView>;
  adminUpdatePromo(actor: M35WriteActor, promoId: string, args: UpdatePromoArgs): Promise<PromoView>;
  adminDeactivatePromo(actor: M35WriteActor, promoId: string): Promise<PromoView>;

  // ── platform-ops revenue (§4.2) ──
  listRevenueSnapshots(cursor?: string, limit?: number): Promise<CursorPage<RevenueSnapshotView>>;
  getCurrentRevenue(): Promise<CurrentRevenueView>;
  recomputeRevenue(actor: M35WriteActor): Promise<RevenueSnapshotView>;

  // ── platform-ops usage + stripe (§4.2) ──
  adminGetTenantUsage(organizationId: string): Promise<UsageCurrentView>;
  listRecentWebhooks(cursor?: string, limit?: number): Promise<CursorPage<WebhookReceiptView>>;
  replayWebhook(actor: M35WriteActor, stripeEventId: string): Promise<AckView>;
}
