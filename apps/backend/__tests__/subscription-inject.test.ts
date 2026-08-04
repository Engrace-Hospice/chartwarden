// apps/backend/__tests__/subscription-inject.test.ts — M35 (Subscription Billing) HTTP-layer smoke suite
// (TASK-050A / TEST-001).
//
// M35 shipped ZERO Fastify `.inject()` coverage before this file: `__tests__/admin-gaps.test.ts` and
// `__tests__/platform-billing-scope.test.ts` (both under `src/modules/35-subscription/__tests__/`) exercise
// narrow slices in isolation, and neither drives a request through Fastify `.inject()` — so a mis-wired
// guard, a permission key that does not match the §4.7 catalog, an ABAC predicate name that does not
// resolve, or a TypeBox schema drifted from the body it guards, is invisible to every one of them. This
// file closes that gap the same way `cap-inject.test.ts` / `discipline-plans-inject.test.ts` did:
// `buildServer()` mounts the M1 host, `mountM35Routes()` mounts all three §4.1/§4.2/§4.3 route groups, the
// REAL Authorization Contract gates every route on the real §4.7 permission keys, and the REAL
// `buildM35AbacPredicates()` resolves the five §4.8 predicates M35 owns.
//
// M35 ships no `createInMemory*Backend` for the route surface (only the Drizzle-backed
// `buildDrizzleM35RouteService`), so — as with M15/M19/M21/M26 — the service half here is a small
// hand-rolled backend built directly against the real, exported `M35RouteService` contract
// (`../src/modules/35-subscription/routes/service`), so the compiler still catches an interface drift. It
// intentionally skips the business rules the Drizzle service enforces (the §4.8
// `plan_change_within_period_grace` / `promo_applicable_to_subscription` re-assertions, the refund
// four-eyes check) — those aren't wired as ABAC-guard preconditions in `routes/guards.ts` either (both
// `BILLING_SCOPE`/`PLATFORM_SCOPE`/`REFUND_APPROVAL` call `requireAbac` with `getTarget: () => ({})`, an
// intentionally empty target — see the guards.ts file banner: the real org/actor scoping is server-side via
// `actorOf`/`writeActorOf` on `request.context`, never the ABAC target), so this file's job — proving every
// route reaches its handler with the RIGHT permission key and a body TypeBox actually validates — does not
// need them modeled.
//
// The webhook route (§4.3, `POST /api/v1/webhooks/stripe`) carries no session/permission gate by design
// (Stripe-Signature HMAC only) and fails closed (503) with no bound `ingest` — per the task's "do not call
// out to the network" instruction, this file supplies a minimal in-memory fake satisfying the exact
// `M35WebhookIngest` port shape instead of a real Stripe verifier, mirroring the module's own
// composition-root seam. `GET /api/v1/plans` (route 1) likewise carries NO preHandler at all — a
// deliberately public marketing read (tenant.routes.ts's own comment: "no permission key") — so neither
// route participates in the shared 401/403 boundary cases below; that is the route table's own design, not
// a gap in this file.
import { randomUUID } from "node:crypto";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { NotFoundError } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  buildM35AbacPredicates,
  M35_PERMISSION_KEY_LIST,
  mountM35Routes,
  type M35WebhookIngest,
} from "../src/modules/35-subscription/index";
import type { M35ReadActor, M35WriteActor } from "../src/modules/35-subscription/routes/actor";
import type { CursorPage } from "../src/modules/35-subscription/routes/concurrency";
import type {
  AckView,
  AddMeterArgs,
  AdminSubscriptionListFilters,
  AttachPaymentMethodArgs,
  BillingStatusView,
  ChangePlanArgs,
  CreatePlanArgs,
  CreatePromoArgs,
  CreateSubscriptionArgs,
  CurrentRevenueView,
  DunningListFilters,
  DunningListItemView,
  DunningView,
  InvoiceDetailView,
  InvoiceListItemView,
  M35RouteService,
  MeterAdminView,
  PaymentMethodView,
  PlanAdminView,
  PlanCatalogView,
  PromoApplicationView,
  PromoView,
  RedirectUrlView,
  RefundView,
  RequestRefundArgs,
  RevenueSnapshotView,
  SetupIntentView,
  SubscriptionAdminView,
  SubscriptionView,
  UpdateMeterArgs,
  UpdatePlanArgs,
  UpdatePromoArgs,
  UsageCurrentView,
  UsagePeriodView,
  WebhookReceiptView,
} from "../src/modules/35-subscription/routes/service";

// ── the header-auth shim (the M11/M15/M26 precedent), extended with the §D14 step-up header (the
// `cap-inject.test.ts` precedent) and the write-actor membership header (the M15 precedent — M35's
// `writeActorOf` 401s a mutating request with no `attributes.membershipId`). ──────────────────────────────
function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  const roles = request.headers["x-test-roles"];
  request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
  const membership = request.headers["x-test-membership"];
  if (typeof membership === "string" && membership.length > 0) {
    request.context.attributes.membershipId = membership;
  }
  if (request.headers["x-test-step-up"] === "1") {
    request.context.attributes.stepUpRecent = true;
  }
}

// ── fixed ids (the M15/M26 style — distinct, valid-`uuid`-format constants where a route's TypeBox schema
// requires `format: "uuid"`) ─────────────────────────────────────────────────────────────────────────────
const ORG = "org_a";
const NOW = "2026-08-04T12:00:00.000Z";
const PLAN_ID = "11111111-1111-4111-8111-111111111111";
const PLAN_SLUG = "starter-monthly";
const PLAN2_ID = "22222222-2222-4222-8222-222222222222";
const PLAN2_SLUG = "professional-monthly";
const METER_ID = "33333333-3333-4333-8333-333333333333";
const SUB_ID = "44444444-4444-4444-8444-444444444444";
const PM_ID = "55555555-5555-4555-8555-555555555555";
const INVOICE_ID = "66666666-6666-4666-8666-666666666666";
const REFUND_ID = "77777777-7777-4777-8777-777777777777";
const PROMO_ID = "88888888-8888-4888-8888-888888888888";
const PROMO_CODE = "WELCOME10";
const MEMBERSHIP = "99999999-9999-4999-8999-999999999999";
const APPLICATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USAGE_ORG_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WEBHOOK_EVENT_ID = "evt_test_0001";

// ── the in-memory M35 backend (this file's own — M35 ships no `createInMemory*Backend` for the route
// surface, only the Drizzle-backed builder) ─────────────────────────────────────────────────────────────
interface MeterRow {
  readonly id: string;
  readonly planId: string;
  eventType: string;
  label: string;
  inclusiveQuantity: number;
  overageUnitPriceCents: number;
  billingAggregation: string;
  warningThresholdPercent: number;
}
interface PlanRow {
  readonly id: string;
  slug: string;
  name: string;
  description: string | null;
  tier: PlanCatalogView["tier"];
  cadence: PlanCatalogView["cadence"];
  basePriceCents: number;
  currencyCode: string;
  trialPeriodDays: number;
  isActive: boolean;
  deprecatedAt: string | null;
  stripeProductId: string | null;
  stripePriceId: string | null;
}
interface SubRow {
  id: string;
  organizationId: string;
  organizationName: string;
  planSlug: string;
  planName: string;
  planTier: PlanCatalogView["tier"];
  status: SubscriptionView["status"];
  trialEndsAt: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  defaultPaymentMethodLast4: string | null;
  defaultPaymentMethodBrand: string | null;
  defaultPaymentMethodExpiresAt: string | null;
  dunningStage: SubscriptionView["dunningStage"];
  dunningEnteredAt: string;
  dunningNextAttemptAt: string | null;
  stripeSubscriptionId: string | null;
  startedAt: string;
}
interface PmRow {
  id: string;
  organizationId: string;
  kind: string;
  brand: string | null;
  last4: string | null;
  expiresAt: string | null;
  isDefault: boolean;
  isActive: boolean;
}
interface InvoiceRow extends InvoiceDetailView {
  readonly organizationId: string;
}
interface RefundRow extends RefundView {
  readonly organizationId2: string;
}
interface PromoRow extends PromoView {
  code: string;
}
interface RevenueRow extends RevenueSnapshotView {}
interface WebhookReceiptRow extends WebhookReceiptView {}

function page<T>(items: readonly T[]): CursorPage<T> {
  return { items, nextCursor: null, hasMore: false };
}

function createM35Backend(): { readonly service: M35RouteService } {
  const plans = new Map<string, PlanRow>();
  const meters = new Map<string, MeterRow>();
  const subscriptions = new Map<string, SubRow>(); // keyed by subscription id
  const subByOrg = new Map<string, string>(); // orgId -> subscription id
  const paymentMethods = new Map<string, PmRow>();
  const invoices = new Map<string, InvoiceRow>();
  const refunds = new Map<string, RefundRow>();
  const promos = new Map<string, PromoRow>();
  const revenueSnapshots = new Map<string, RevenueRow>();
  const webhookReceipts = new Map<string, WebhookReceiptRow>();

  // ── seed fixtures ──
  plans.set(PLAN_ID, {
    id: PLAN_ID,
    slug: PLAN_SLUG,
    name: "Starter (Monthly)",
    description: "The seed starter plan",
    tier: "starter",
    cadence: "monthly",
    basePriceCents: 4900,
    currencyCode: "usd",
    trialPeriodDays: 14,
    isActive: true,
    deprecatedAt: null,
    stripeProductId: null,
    stripePriceId: null,
  });
  plans.set(PLAN2_ID, {
    id: PLAN2_ID,
    slug: PLAN2_SLUG,
    name: "Professional (Monthly)",
    description: "The seed professional plan",
    tier: "professional",
    cadence: "monthly",
    basePriceCents: 9900,
    currencyCode: "usd",
    trialPeriodDays: 14,
    isActive: true,
    deprecatedAt: null,
    stripeProductId: null,
    stripePriceId: null,
  });
  meters.set(METER_ID, {
    id: METER_ID,
    planId: PLAN_ID,
    eventType: "api_call",
    label: "API calls",
    inclusiveQuantity: 1000,
    overageUnitPriceCents: 1,
    billingAggregation: "sum",
    warningThresholdPercent: 80,
  });
  subscriptions.set(SUB_ID, {
    id: SUB_ID,
    organizationId: ORG,
    organizationName: "Org A",
    planSlug: PLAN_SLUG,
    planName: "Starter (Monthly)",
    planTier: "starter",
    status: "active",
    trialEndsAt: null,
    currentPeriodStart: NOW,
    currentPeriodEnd: NOW,
    cancelAtPeriodEnd: false,
    canceledAt: null,
    defaultPaymentMethodLast4: "4242",
    defaultPaymentMethodBrand: "visa",
    defaultPaymentMethodExpiresAt: "2030-01-01",
    dunningStage: "day_7",
    dunningEnteredAt: NOW,
    dunningNextAttemptAt: NOW,
    stripeSubscriptionId: null,
    startedAt: NOW,
  });
  subByOrg.set(ORG, SUB_ID);
  paymentMethods.set(PM_ID, {
    id: PM_ID,
    organizationId: ORG,
    kind: "card",
    brand: "visa",
    last4: "4242",
    expiresAt: "2030-01-01",
    isDefault: true,
    isActive: true,
  });
  invoices.set(INVOICE_ID, {
    id: INVOICE_ID,
    organizationId: ORG,
    invoiceNumber: "INV-0001",
    status: "paid",
    totalCents: 4900,
    currencyCode: "usd",
    periodStart: NOW,
    periodEnd: NOW,
    issuedAt: NOW,
    dueAt: NOW,
    paidAt: NOW,
    subtotalCents: 4900,
    taxCents: 0,
    amountPaidCents: 4900,
    lines: [
      {
        id: randomUUID(),
        kind: "subscription",
        description: "Starter (Monthly) — one period",
        quantity: 1,
        unitAmountCents: 4900,
        totalCents: 4900,
      },
    ],
  });
  refunds.set(REFUND_ID, {
    id: REFUND_ID,
    organizationId: ORG,
    organizationId2: ORG,
    organizationName: "Org A",
    invoiceId: INVOICE_ID,
    amountCents: 4900,
    kind: "full",
    reasonCode: "requested_by_customer",
    status: "requested",
    requestedByMembershipId: MEMBERSHIP,
    requestedAt: NOW,
    approvedByMembershipId: null,
    approvedAt: null,
    deniedReason: null,
    executedAt: null,
    stripeRefundId: null,
  });
  promos.set(PROMO_ID, {
    id: PROMO_ID,
    code: PROMO_CODE,
    kind: "percent_off",
    percentOff: 10,
    fixedOffCents: null,
    duration: "once",
    durationInMonths: null,
    validFrom: null,
    validTo: null,
    maxRedemptions: 100,
    redemptionCount: 0,
    isActive: true,
  });
  webhookReceipts.set(WEBHOOK_EVENT_ID, {
    stripeEventId: WEBHOOK_EVENT_ID,
    eventType: "invoice.paid",
    receivedAt: NOW,
    processedAt: NOW,
    processingAttemptCount: 1,
    derivedOrganizationId: ORG,
  });

  function requirePlanBySlug(slug: string): PlanRow {
    const row = [...plans.values()].find((p) => p.slug === slug);
    if (!row) throw new NotFoundError("subscription_plan", slug);
    return row;
  }
  function requirePlan(id: string): PlanRow {
    const row = plans.get(id);
    if (!row) throw new NotFoundError("subscription_plan", id);
    return row;
  }
  function requireMeter(id: string): MeterRow {
    const row = meters.get(id);
    if (!row) throw new NotFoundError("subscription_plan_meter", id);
    return row;
  }
  function requireSubForOrg(orgId: string): SubRow {
    const id = subByOrg.get(orgId);
    const row = id ? subscriptions.get(id) : undefined;
    if (!row) throw new NotFoundError("subscription", orgId);
    return row;
  }
  function requireSub(id: string): SubRow {
    const row = subscriptions.get(id);
    if (!row) throw new NotFoundError("subscription", id);
    return row;
  }
  function requirePm(orgId: string, id: string): PmRow {
    const row = paymentMethods.get(id);
    if (!row || row.organizationId !== orgId) throw new NotFoundError("payment_method", id);
    return row;
  }
  function requireInvoice(orgId: string, id: string): InvoiceRow {
    const row = invoices.get(id);
    if (!row || row.organizationId !== orgId) throw new NotFoundError("subscription_invoice", id);
    return row;
  }
  function requireRefund(id: string): RefundRow {
    const row = refunds.get(id);
    if (!row) throw new NotFoundError("subscription_refund", id);
    return row;
  }
  function requirePromo(id: string): PromoRow {
    const row = promos.get(id);
    if (!row) throw new NotFoundError("subscription_promo", id);
    return row;
  }
  function requirePromoByCode(code: string): PromoRow {
    const row = [...promos.values()].find((p) => p.code === code);
    if (!row) throw new NotFoundError("subscription_promo", code);
    return row;
  }

  function metersForPlan(planId: string): MeterRow[] {
    return [...meters.values()].filter((m) => m.planId === planId);
  }
  function toCatalogView(plan: PlanRow): PlanCatalogView {
    return {
      slug: plan.slug,
      name: plan.name,
      description: plan.description,
      tier: plan.tier,
      cadence: plan.cadence,
      basePriceCents: plan.basePriceCents,
      currencyCode: plan.currencyCode,
      trialPeriodDays: plan.trialPeriodDays,
      meters: metersForPlan(plan.id).map((m) => ({
        eventType: m.eventType,
        label: m.label,
        inclusiveQuantity: m.inclusiveQuantity,
        overageUnitPriceCents: m.overageUnitPriceCents,
        billingAggregation: m.billingAggregation,
      })),
    };
  }
  function toPlanAdminView(plan: PlanRow): PlanAdminView {
    return {
      ...toCatalogView(plan),
      id: plan.id,
      isActive: plan.isActive,
      deprecatedAt: plan.deprecatedAt,
      stripeProductId: plan.stripeProductId,
      stripePriceId: plan.stripePriceId,
    };
  }
  function toMeterAdminView(m: MeterRow): MeterAdminView {
    return { ...m };
  }
  function toSubscriptionView(row: SubRow): SubscriptionView {
    return {
      id: row.id,
      organizationId: row.organizationId,
      planSlug: row.planSlug,
      planName: row.planName,
      status: row.status,
      trialEndsAt: row.trialEndsAt,
      currentPeriodStart: row.currentPeriodStart,
      currentPeriodEnd: row.currentPeriodEnd,
      cancelAtPeriodEnd: row.cancelAtPeriodEnd,
      canceledAt: row.canceledAt,
      defaultPaymentMethodLast4: row.defaultPaymentMethodLast4,
      defaultPaymentMethodBrand: row.defaultPaymentMethodBrand,
      defaultPaymentMethodExpiresAt: row.defaultPaymentMethodExpiresAt,
      dunningStage: row.dunningStage,
    };
  }
  function toSubscriptionAdminView(row: SubRow): SubscriptionAdminView {
    return {
      ...toSubscriptionView(row),
      planTier: row.planTier,
      stripeSubscriptionId: row.stripeSubscriptionId,
      startedAt: row.startedAt,
      organizationName: row.organizationName,
    };
  }
  function toDunningView(row: SubRow): DunningView {
    return {
      subscriptionId: row.id,
      stage: row.dunningStage,
      enteredAt: row.dunningEnteredAt,
      nextAttemptAt: row.dunningNextAttemptAt,
    };
  }
  function toDunningListItem(row: SubRow): DunningListItemView {
    return {
      subscriptionId: row.id,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      planName: row.planName,
      subscriptionStatus: row.status,
      stage: row.dunningStage,
      enteredAt: row.dunningEnteredAt,
      nextAttemptAt: row.dunningNextAttemptAt,
    };
  }
  function toPmView(row: PmRow): PaymentMethodView {
    return {
      id: row.id,
      kind: row.kind,
      brand: row.brand,
      last4: row.last4,
      expiresAt: row.expiresAt,
      isDefault: row.isDefault,
      isActive: row.isActive,
    };
  }
  function toRefundView(row: RefundRow): RefundView {
    const { organizationId2: _drop, ...view } = row;
    void _drop;
    return view;
  }

  const service: M35RouteService = {
    // ── tenant (§4.1) ──
    async listActivePlans(): Promise<PlanCatalogView[]> {
      return [...plans.values()].filter((p) => p.isActive).map(toCatalogView);
    },
    async getSubscription(actor: M35ReadActor): Promise<SubscriptionView | null> {
      const id = subByOrg.get(actor.organizationId);
      const row = id ? subscriptions.get(id) : undefined;
      return row ? toSubscriptionView(row) : null;
    },
    async createSubscription(actor: M35WriteActor, args: CreateSubscriptionArgs): Promise<SubscriptionView> {
      const plan = requirePlanBySlug(args.planSlug);
      const id = randomUUID();
      const row: SubRow = {
        id,
        organizationId: actor.organizationId,
        organizationName: "Org A",
        planSlug: plan.slug,
        planName: plan.name,
        planTier: plan.tier,
        status: "trialing",
        trialEndsAt: NOW,
        currentPeriodStart: NOW,
        currentPeriodEnd: NOW,
        cancelAtPeriodEnd: false,
        canceledAt: null,
        defaultPaymentMethodLast4: null,
        defaultPaymentMethodBrand: null,
        defaultPaymentMethodExpiresAt: null,
        dunningStage: "none",
        dunningEnteredAt: NOW,
        dunningNextAttemptAt: null,
        stripeSubscriptionId: null,
        startedAt: NOW,
      };
      subscriptions.set(id, row);
      subByOrg.set(actor.organizationId, id);
      return toSubscriptionView(row);
    },
    async changePlan(actor: M35WriteActor, args: ChangePlanArgs): Promise<SubscriptionView> {
      const row = requireSubForOrg(actor.organizationId);
      const plan = requirePlanBySlug(args.newPlanSlug);
      const updated: SubRow = { ...row, planSlug: plan.slug, planName: plan.name, planTier: plan.tier };
      subscriptions.set(row.id, updated);
      return toSubscriptionView(updated);
    },
    async cancelSubscription(actor: M35WriteActor): Promise<SubscriptionView> {
      const row = requireSubForOrg(actor.organizationId);
      const updated: SubRow = { ...row, cancelAtPeriodEnd: true, canceledAt: NOW };
      subscriptions.set(row.id, updated);
      return toSubscriptionView(updated);
    },
    async resumeSubscription(actor: M35WriteActor): Promise<SubscriptionView> {
      const row = requireSubForOrg(actor.organizationId);
      const updated: SubRow = { ...row, cancelAtPeriodEnd: false, canceledAt: null };
      subscriptions.set(row.id, updated);
      return toSubscriptionView(updated);
    },
    async applyPromoTenant(actor: M35WriteActor, promoCode: string): Promise<PromoApplicationView> {
      const row = requireSubForOrg(actor.organizationId);
      const promo = requirePromoByCode(promoCode);
      return { applicationId: randomUUID(), subscriptionId: row.id, promoCode: promo.code, applied: true };
    },
    async listPaymentMethods(actor: M35ReadActor): Promise<PaymentMethodView[]> {
      return [...paymentMethods.values()].filter((p) => p.organizationId === actor.organizationId).map(toPmView);
    },
    async createSetupIntent(_actor: M35WriteActor): Promise<SetupIntentView> {
      return { clientSecret: null, status: "pending" };
    },
    async attachPaymentMethod(actor: M35WriteActor, args: AttachPaymentMethodArgs): Promise<PaymentMethodView> {
      const id = randomUUID();
      const row: PmRow = {
        id,
        organizationId: actor.organizationId,
        kind: "card",
        brand: "visa",
        last4: "1111",
        expiresAt: "2031-01-01",
        isDefault: args.setAsDefault ?? false,
        isActive: true,
      };
      paymentMethods.set(id, row);
      return toPmView(row);
    },
    async setDefaultPaymentMethod(actor: M35WriteActor, paymentMethodId: string): Promise<PaymentMethodView> {
      const row = requirePm(actor.organizationId, paymentMethodId);
      const updated: PmRow = { ...row, isDefault: true };
      paymentMethods.set(paymentMethodId, updated);
      return toPmView(updated);
    },
    async detachPaymentMethod(actor: M35WriteActor, paymentMethodId: string): Promise<AckView> {
      const row = requirePm(actor.organizationId, paymentMethodId);
      paymentMethods.set(paymentMethodId, { ...row, isActive: false });
      return { ok: true };
    },
    async listInvoices(actor: M35ReadActor): Promise<CursorPage<InvoiceListItemView>> {
      return page([...invoices.values()].filter((i) => i.organizationId === actor.organizationId));
    },
    async getInvoice(actor: M35ReadActor, invoiceId: string): Promise<InvoiceDetailView> {
      return requireInvoice(actor.organizationId, invoiceId);
    },
    async getInvoiceHostedUrl(actor: M35ReadActor, invoiceId: string): Promise<RedirectUrlView> {
      requireInvoice(actor.organizationId, invoiceId);
      return { url: `https://billing.stripe.com/invoice/${invoiceId}` };
    },
    async getInvoicePdfUrl(actor: M35ReadActor, invoiceId: string): Promise<RedirectUrlView> {
      requireInvoice(actor.organizationId, invoiceId);
      return { url: `https://billing.stripe.com/invoice/${invoiceId}/pdf` };
    },
    async getUsageCurrent(_actor: M35ReadActor): Promise<UsageCurrentView> {
      return {
        periodStart: NOW,
        periodEnd: NOW,
        meters: metersForPlan(PLAN_ID).map((m) => ({
          eventType: m.eventType,
          label: m.label,
          totalQuantity: 500,
          inclusiveQuantity: m.inclusiveQuantity,
          overageQuantity: 0,
          overageUnitPriceCents: m.overageUnitPriceCents,
          projectedOverageCostCents: 0,
          thresholdState: "ok",
        })),
      };
    },
    async getUsageHistory(): Promise<CursorPage<UsagePeriodView>> {
      return page([
        { periodStart: NOW, periodEnd: NOW, totalQuantity: 500, inclusiveQuantity: 1000, overageQuantity: 0 },
      ]);
    },
    async getBillingStatus(actor: M35ReadActor): Promise<BillingStatusView> {
      const row = requireSubForOrg(actor.organizationId);
      return {
        status: row.status,
        isBlockedByBilling: row.status === "suspended",
        dunningStage: row.dunningStage,
        daysUntilSuspension: row.dunningStage === "none" ? null : 7,
        hasValidPaymentMethod: row.defaultPaymentMethodLast4 !== null,
        paymentMethodExpiresAt: row.defaultPaymentMethodExpiresAt,
      };
    },

    // ── platform-ops plans (§4.2) ──
    async adminListPlans(): Promise<PlanAdminView[]> {
      return [...plans.values()].map(toPlanAdminView);
    },
    async adminGetPlan(planId: string): Promise<PlanAdminView> {
      return toPlanAdminView(requirePlan(planId));
    },
    async adminCreatePlan(_actor: M35WriteActor, args: CreatePlanArgs): Promise<PlanAdminView> {
      const id = randomUUID();
      const row: PlanRow = {
        id,
        slug: args.slug,
        name: args.name,
        description: args.description ?? null,
        tier: args.tier,
        cadence: args.cadence,
        basePriceCents: args.basePriceCents,
        currencyCode: args.currencyCode,
        trialPeriodDays: args.trialPeriodDays,
        isActive: false,
        deprecatedAt: null,
        stripeProductId: null,
        stripePriceId: null,
      };
      plans.set(id, row);
      return toPlanAdminView(row);
    },
    async adminUpdatePlan(_actor: M35WriteActor, planId: string, args: UpdatePlanArgs): Promise<PlanAdminView> {
      const row = requirePlan(planId);
      const updated: PlanRow = {
        ...row,
        name: args.name ?? row.name,
        description: args.description ?? row.description,
        basePriceCents: args.basePriceCents ?? row.basePriceCents,
        trialPeriodDays: args.trialPeriodDays ?? row.trialPeriodDays,
      };
      plans.set(planId, updated);
      return toPlanAdminView(updated);
    },
    async adminActivatePlan(_actor: M35WriteActor, planId: string): Promise<PlanAdminView> {
      const row = requirePlan(planId);
      const updated: PlanRow = { ...row, isActive: true };
      plans.set(planId, updated);
      return toPlanAdminView(updated);
    },
    async adminDeprecatePlan(_actor: M35WriteActor, planId: string): Promise<PlanAdminView> {
      const row = requirePlan(planId);
      const updated: PlanRow = { ...row, isActive: false, deprecatedAt: NOW };
      plans.set(planId, updated);
      return toPlanAdminView(updated);
    },
    async adminAddMeter(_actor: M35WriteActor, planId: string, args: AddMeterArgs): Promise<MeterAdminView> {
      requirePlan(planId);
      const id = randomUUID();
      const row: MeterRow = {
        id,
        planId,
        eventType: args.eventType,
        label: args.label,
        inclusiveQuantity: args.inclusiveQuantity,
        overageUnitPriceCents: args.overageUnitPriceCents,
        billingAggregation: args.billingAggregation,
        warningThresholdPercent: args.warningThresholdPercent ?? 80,
      };
      meters.set(id, row);
      return toMeterAdminView(row);
    },
    async adminUpdateMeter(
      _actor: M35WriteActor,
      _planId: string,
      meterId: string,
      args: UpdateMeterArgs,
    ): Promise<MeterAdminView> {
      const row = requireMeter(meterId);
      const updated: MeterRow = {
        ...row,
        inclusiveQuantity: args.inclusiveQuantity ?? row.inclusiveQuantity,
        overageUnitPriceCents: args.overageUnitPriceCents ?? row.overageUnitPriceCents,
        warningThresholdPercent: args.warningThresholdPercent ?? row.warningThresholdPercent,
      };
      meters.set(meterId, updated);
      return toMeterAdminView(updated);
    },

    // ── platform-ops subscriptions (§4.2) ──
    async adminListSubscriptions(filters: AdminSubscriptionListFilters): Promise<CursorPage<SubscriptionAdminView>> {
      let rows = [...subscriptions.values()];
      if (filters.status) rows = rows.filter((r) => r.status === filters.status);
      if (filters.organizationId) rows = rows.filter((r) => r.organizationId === filters.organizationId);
      return page(rows.map(toSubscriptionAdminView));
    },
    async adminGetSubscription(subscriptionId: string): Promise<SubscriptionAdminView> {
      return toSubscriptionAdminView(requireSub(subscriptionId));
    },
    async adminPauseSubscription(
      _actor: M35WriteActor,
      subscriptionId: string,
      pausedUntil: string | null,
    ): Promise<SubscriptionAdminView> {
      void pausedUntil;
      const row = requireSub(subscriptionId);
      const updated: SubRow = { ...row, status: "paused" };
      subscriptions.set(subscriptionId, updated);
      return toSubscriptionAdminView(updated);
    },
    async adminResumeSubscription(_actor: M35WriteActor, subscriptionId: string): Promise<SubscriptionAdminView> {
      const row = requireSub(subscriptionId);
      const updated: SubRow = { ...row, status: "active" };
      subscriptions.set(subscriptionId, updated);
      return toSubscriptionAdminView(updated);
    },
    async adminCancelSubscription(_actor: M35WriteActor, subscriptionId: string): Promise<SubscriptionAdminView> {
      const row = requireSub(subscriptionId);
      const updated: SubRow = { ...row, status: "canceled", canceledAt: NOW };
      subscriptions.set(subscriptionId, updated);
      return toSubscriptionAdminView(updated);
    },
    async adminApplyPromo(
      _actor: M35WriteActor,
      subscriptionId: string,
      promoCode: string,
    ): Promise<PromoApplicationView> {
      const row = requireSub(subscriptionId);
      const promo = requirePromoByCode(promoCode);
      return { applicationId: randomUUID(), subscriptionId: row.id, promoCode: promo.code, applied: true };
    },
    async adminRevokePromo(_actor: M35WriteActor, subscriptionId: string, applicationId: string): Promise<AckView> {
      requireSub(subscriptionId);
      void applicationId;
      return { ok: true };
    },

    // ── platform-ops dunning (§4.2) ──
    async adminListDunning(filters: DunningListFilters): Promise<CursorPage<DunningListItemView>> {
      let rows = [...subscriptions.values()].filter((r) => r.dunningStage !== "none");
      if (filters.stage) rows = rows.filter((r) => r.dunningStage === filters.stage);
      return page(rows.map(toDunningListItem));
    },
    async adminSkipDunningStage(_actor: M35WriteActor, subscriptionId: string): Promise<DunningView> {
      const row = requireSub(subscriptionId);
      const updated: SubRow = { ...row, dunningStage: "day_14" };
      subscriptions.set(subscriptionId, updated);
      return toDunningView(updated);
    },
    async adminResetDunning(_actor: M35WriteActor, subscriptionId: string): Promise<DunningView> {
      const row = requireSub(subscriptionId);
      const updated: SubRow = { ...row, dunningStage: "none" };
      subscriptions.set(subscriptionId, updated);
      return toDunningView(updated);
    },

    // ── platform-ops refunds (§4.2) ──
    async requestRefund(actor: M35WriteActor, args: RequestRefundArgs): Promise<RefundView> {
      const id = randomUUID();
      const row: RefundRow = {
        id,
        organizationId: ORG,
        organizationId2: ORG,
        organizationName: "Org A",
        invoiceId: args.invoiceId,
        amountCents: args.amountCents,
        kind: args.kind,
        reasonCode: args.reasonCode,
        status: "requested",
        requestedByMembershipId: actor.membershipId,
        requestedAt: NOW,
        approvedByMembershipId: null,
        approvedAt: null,
        deniedReason: null,
        executedAt: null,
        stripeRefundId: null,
      };
      refunds.set(id, row);
      return toRefundView(row);
    },
    async approveRefund(actor: M35WriteActor, refundId: string): Promise<RefundView> {
      const row = requireRefund(refundId);
      const updated: RefundRow = { ...row, status: "approved", approvedByMembershipId: actor.membershipId, approvedAt: NOW };
      refunds.set(refundId, updated);
      return toRefundView(updated);
    },
    async denyRefund(_actor: M35WriteActor, refundId: string, reason: string): Promise<RefundView> {
      const row = requireRefund(refundId);
      const updated: RefundRow = { ...row, status: "denied", deniedReason: reason };
      refunds.set(refundId, updated);
      return toRefundView(updated);
    },
    async listRefunds(): Promise<CursorPage<RefundView>> {
      return page([...refunds.values()].map(toRefundView));
    },
    async adminGetRefund(refundId: string): Promise<RefundView> {
      return toRefundView(requireRefund(refundId));
    },

    // ── platform-ops promos (§4.2) ──
    async adminListPromos(): Promise<PromoView[]> {
      return [...promos.values()];
    },
    async adminGetPromo(promoId: string): Promise<PromoView> {
      return requirePromo(promoId);
    },
    async adminCreatePromo(_actor: M35WriteActor, args: CreatePromoArgs): Promise<PromoView> {
      const id = randomUUID();
      const row: PromoRow = {
        id,
        code: args.code,
        kind: args.kind,
        percentOff: args.percentOff ?? null,
        fixedOffCents: args.fixedOffCents ?? null,
        duration: args.duration,
        durationInMonths: args.durationInMonths ?? null,
        validFrom: args.validFrom ?? null,
        validTo: args.validTo ?? null,
        maxRedemptions: args.maxRedemptions ?? null,
        redemptionCount: 0,
        isActive: true,
      };
      promos.set(id, row);
      return row;
    },
    async adminUpdatePromo(_actor: M35WriteActor, promoId: string, args: UpdatePromoArgs): Promise<PromoView> {
      const row = requirePromo(promoId);
      const updated: PromoRow = {
        ...row,
        validTo: args.validTo ?? row.validTo,
        maxRedemptions: args.maxRedemptions ?? row.maxRedemptions,
      };
      promos.set(promoId, updated);
      return updated;
    },
    async adminDeactivatePromo(_actor: M35WriteActor, promoId: string): Promise<PromoView> {
      const row = requirePromo(promoId);
      const updated: PromoRow = { ...row, isActive: false };
      promos.set(promoId, updated);
      return updated;
    },

    // ── platform-ops revenue (§4.2) ──
    async listRevenueSnapshots(): Promise<CursorPage<RevenueSnapshotView>> {
      return page([...revenueSnapshots.values()]);
    },
    async getCurrentRevenue(): Promise<CurrentRevenueView> {
      return { mrrCents: 490_000, arrCents: 5_880_000, activeSubscriptions: 42, asOf: NOW };
    },
    async recomputeRevenue(_actor: M35WriteActor): Promise<RevenueSnapshotView> {
      const id = randomUUID();
      const row: RevenueRow = {
        id,
        snapshotMonth: "2026-08",
        mrrCents: 490_000,
        arrCents: 5_880_000,
        newMrrCents: 10_000,
        expansionMrrCents: 5_000,
        contractionMrrCents: 0,
        churnMrrCents: 0,
        activeSubscriptions: 42,
        trialingSubscriptions: 3,
        pastDueSubscriptions: 1,
        computedAt: NOW,
      };
      revenueSnapshots.set(id, row);
      return row;
    },

    // ── platform-ops usage + stripe (§4.2) ──
    async adminGetTenantUsage(organizationId: string): Promise<UsageCurrentView> {
      void organizationId;
      return {
        periodStart: NOW,
        periodEnd: NOW,
        meters: metersForPlan(PLAN_ID).map((m) => ({
          eventType: m.eventType,
          label: m.label,
          totalQuantity: 500,
          inclusiveQuantity: m.inclusiveQuantity,
          overageQuantity: 0,
          overageUnitPriceCents: m.overageUnitPriceCents,
          projectedOverageCostCents: 0,
          thresholdState: "ok",
        })),
      };
    },
    async listRecentWebhooks(): Promise<CursorPage<WebhookReceiptView>> {
      return page([...webhookReceipts.values()]);
    },
    async replayWebhook(_actor: M35WriteActor, stripeEventId: string): Promise<AckView> {
      if (!webhookReceipts.has(stripeEventId)) throw new NotFoundError("stripe_webhook_event", stripeEventId);
      return { ok: true };
    },
  };

  return { service };
}

// ── the §4.3 webhook ingest fake — satisfies the exact `M35WebhookIngest` port shape the composition root
// binds a real Stripe verifier over; this file never calls out to the network (per the task constraint). ──
const fakeIngest: M35WebhookIngest = async ({ signatureHeader }) => {
  if (signatureHeader === "sig_invalid") return { kind: "invalid_signature" };
  return { kind: "accepted" };
};

// ── server assembly (the M11/M15/M26 `makeServer()` precedent) ─────────────────────────────────────────
const SUPER_HEADERS = {
  "x-test-user": "super_1",
  "x-test-org": ORG,
  "x-test-roles": "platform_admin",
  "x-test-membership": MEMBERSHIP,
  "x-test-step-up": "1",
};
const NONE_HEADERS = { "x-test-user": "none_1", "x-test-org": ORG, "x-test-roles": "" };

function makeServer() {
  const backend = createM35Backend();

  const grantStore = createInMemoryEffectivePermissionStore([
    { orgId: ORG, userId: "super_1", grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [...M35_PERMISSION_KEY_LIST] }] },
    { orgId: ORG, userId: "none_1", grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: [] }] },
  ]);
  registerEffectivePermissionResolver(grantStore.store);

  // A FRESH predicate registry per server (the M11-T06 precedent): the five §4.8 predicates M35 owns are
  // pure over (context, target) — no resolver dependency, unlike M15/M26 — plus a permissive `step_up_recent`
  // stub reading the header-set `attributes.stepUpRecent` (the `cap-inject.test.ts` precedent), so the
  // §D14 STEP_UP-gated routes' 2xx path is genuinely exercised.
  const reg = createPredicateRegistry();
  for (const [name, predicate] of Object.entries(buildM35AbacPredicates())) {
    reg.register(name, predicate);
  }
  reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
  registerAbacRegistry(reg);

  const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
  mountM35Routes(app, { service: backend.service, webhook: { ingest: fakeIngest } });
  return { app, backend };
}

beforeEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
  resetAbacRegistry();
});

// ── the M1 boundary: 401 / 403 / 422 ─────────────────────────────────────────────────────────────────────
describe("M35 route smoke — the M1 boundary", () => {
  it("401s with no session at all", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/subscription" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("403s a permission-gated route for a session holding NO M35 grants", async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: "GET", url: "/api/v1/subscription", headers: NONE_HEADERS });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("422s a malformed body from an otherwise-authorized caller (TypeBox validation, M1 envelope)", async () => {
    const { app } = makeServer();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/subscription",
      headers: { ...SUPER_HEADERS, "idempotency-key": randomUUID() },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
    await app.close();
  });
});

// ── one legitimately-authorized 2xx call per route (the bulk of the file) ──────────────────────────────
interface RouteCase {
  readonly label: string;
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly payload?: Record<string, unknown>;
  readonly expectStatus: number;
}

const IDEMP = () => ({ "idempotency-key": randomUUID() });

const ROUTE_CASES: readonly RouteCase[] = [
  // ── §4.1 tenant surface (routes 1-19) ──
  { label: "1 GET /v1/plans (public, no permission key)", method: "GET", url: "/api/v1/plans", headers: {}, expectStatus: 200 },
  { label: "2 GET /v1/subscription", method: "GET", url: "/api/v1/subscription", headers: SUPER_HEADERS, expectStatus: 200 },
  {
    label: "3 POST /v1/subscription",
    method: "POST",
    url: "/api/v1/subscription",
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: { planSlug: PLAN_SLUG, paymentMethodId: PM_ID },
    expectStatus: 201,
  },
  {
    label: "4 PATCH /v1/subscription",
    method: "PATCH",
    url: "/api/v1/subscription",
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: { newPlanSlug: PLAN2_SLUG, prorationBehavior: "create_prorations" },
    expectStatus: 200,
  },
  {
    label: "5 POST /v1/subscription/cancel",
    method: "POST",
    url: "/api/v1/subscription/cancel",
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "6 POST /v1/subscription/resume",
    method: "POST",
    url: "/api/v1/subscription/resume",
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "7 POST /v1/subscription/apply_promo",
    method: "POST",
    url: "/api/v1/subscription/apply_promo",
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: { promoCode: PROMO_CODE },
    expectStatus: 200,
  },
  { label: "8 GET /v1/payment_methods", method: "GET", url: "/api/v1/payment_methods", headers: SUPER_HEADERS, expectStatus: 200 },
  {
    label: "9 POST /v1/payment_methods/setup_intent",
    method: "POST",
    url: "/api/v1/payment_methods/setup_intent",
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: {},
    expectStatus: 202,
  },
  {
    label: "10 POST /v1/payment_methods/attach",
    method: "POST",
    url: "/api/v1/payment_methods/attach",
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: { stripePaymentMethodId: "pm_test_123", setAsDefault: true },
    expectStatus: 201,
  },
  {
    label: "11 PATCH /v1/payment_methods/:id/set_default",
    method: "PATCH",
    url: `/api/v1/payment_methods/${PM_ID}/set_default`,
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "12 DELETE /v1/payment_methods/:id",
    method: "DELETE",
    url: `/api/v1/payment_methods/${PM_ID}`,
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    expectStatus: 200,
  },
  { label: "13 GET /v1/invoices", method: "GET", url: "/api/v1/invoices", headers: SUPER_HEADERS, expectStatus: 200 },
  { label: "14 GET /v1/invoices/:id", method: "GET", url: `/api/v1/invoices/${INVOICE_ID}`, headers: SUPER_HEADERS, expectStatus: 200 },
  { label: "15 GET /v1/invoices/:id/hosted_url", method: "GET", url: `/api/v1/invoices/${INVOICE_ID}/hosted_url`, headers: SUPER_HEADERS, expectStatus: 200 },
  { label: "16 GET /v1/invoices/:id/pdf", method: "GET", url: `/api/v1/invoices/${INVOICE_ID}/pdf`, headers: SUPER_HEADERS, expectStatus: 200 },
  { label: "17 GET /v1/usage/current", method: "GET", url: "/api/v1/usage/current", headers: SUPER_HEADERS, expectStatus: 200 },
  { label: "18 GET /v1/usage/history", method: "GET", url: "/api/v1/usage/history", headers: SUPER_HEADERS, expectStatus: 200 },
  { label: "19 GET /v1/billing/status", method: "GET", url: "/api/v1/billing/status", headers: SUPER_HEADERS, expectStatus: 200 },

  // ── §4.2 platform-ops plans (routes 20-27) ──
  { label: "20 GET /admin/plans", method: "GET", url: "/api/admin/plans", headers: SUPER_HEADERS, expectStatus: 200 },
  { label: "21 GET /admin/plans/:id", method: "GET", url: `/api/admin/plans/${PLAN_ID}`, headers: SUPER_HEADERS, expectStatus: 200 },
  {
    label: "22 POST /admin/plans",
    method: "POST",
    url: "/api/admin/plans",
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: {
      slug: "enterprise-annual",
      name: "Enterprise (Annual)",
      tier: "enterprise",
      cadence: "annual",
      basePriceCents: 990_000,
      currencyCode: "usd",
      trialPeriodDays: 30,
    },
    expectStatus: 201,
  },
  {
    label: "23 PATCH /admin/plans/:id",
    method: "PATCH",
    url: `/api/admin/plans/${PLAN_ID}`,
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: { name: "Starter (Monthly) — updated" },
    expectStatus: 200,
  },
  {
    label: "24 POST /admin/plans/:id/activate",
    method: "POST",
    url: `/api/admin/plans/${PLAN_ID}/activate`,
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "25 POST /admin/plans/:id/deprecate",
    method: "POST",
    url: `/api/admin/plans/${PLAN2_ID}/deprecate`,
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "26 POST /admin/plans/:id/meters",
    method: "POST",
    url: `/api/admin/plans/${PLAN_ID}/meters`,
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: { eventType: "storage_gb", label: "Storage (GB)", inclusiveQuantity: 100, overageUnitPriceCents: 5, billingAggregation: "sum" },
    expectStatus: 201,
  },
  {
    label: "27 PATCH /admin/plans/:id/meters/:meterId",
    method: "PATCH",
    url: `/api/admin/plans/${PLAN_ID}/meters/${METER_ID}`,
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: { inclusiveQuantity: 2000 },
    expectStatus: 200,
  },

  // ── §4.2 platform-ops subscriptions (routes 28-34) ──
  { label: "28 GET /admin/subscriptions", method: "GET", url: "/api/admin/subscriptions", headers: SUPER_HEADERS, expectStatus: 200 },
  { label: "29 GET /admin/subscriptions/:id", method: "GET", url: `/api/admin/subscriptions/${SUB_ID}`, headers: SUPER_HEADERS, expectStatus: 200 },
  {
    label: "30 POST /admin/subscriptions/:id/pause",
    method: "POST",
    url: `/api/admin/subscriptions/${SUB_ID}/pause`,
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "31 POST /admin/subscriptions/:id/resume",
    method: "POST",
    url: `/api/admin/subscriptions/${SUB_ID}/resume`,
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "32 POST /admin/subscriptions/:id/cancel",
    method: "POST",
    url: `/api/admin/subscriptions/${SUB_ID}/cancel`,
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "33 POST /admin/subscriptions/:id/apply_promo",
    method: "POST",
    url: `/api/admin/subscriptions/${SUB_ID}/apply_promo`,
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: { promoCode: PROMO_CODE },
    expectStatus: 200,
  },
  {
    label: "34 POST /admin/subscriptions/:id/revoke_promo",
    method: "POST",
    url: `/api/admin/subscriptions/${SUB_ID}/revoke_promo`,
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: { applicationId: APPLICATION_ID },
    expectStatus: 200,
  },

  // ── §4.2 platform-ops dunning (routes 35-37) ──
  { label: "35 GET /admin/dunning", method: "GET", url: "/api/admin/dunning", headers: SUPER_HEADERS, expectStatus: 200 },
  {
    label: "36 POST /admin/dunning/:subscriptionId/skip_stage",
    method: "POST",
    url: `/api/admin/dunning/${SUB_ID}/skip_stage`,
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "37 POST /admin/dunning/:subscriptionId/reset",
    method: "POST",
    url: `/api/admin/dunning/${SUB_ID}/reset`,
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: {},
    expectStatus: 200,
  },

  // ── §4.2 platform-ops refunds (routes 38-42) ──
  {
    label: "38 POST /admin/refunds",
    method: "POST",
    url: "/api/admin/refunds",
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: {
      invoiceId: INVOICE_ID,
      amountCents: 4900,
      kind: "full",
      reasonCode: "requested_by_customer",
      reasonDetail: "The customer requested a full refund after cancelling within the trial window.",
    },
    expectStatus: 201,
  },
  {
    label: "39 POST /admin/refunds/:id/approve",
    method: "POST",
    url: `/api/admin/refunds/${REFUND_ID}/approve`,
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: {},
    expectStatus: 200,
  },
  {
    label: "40 POST /admin/refunds/:id/deny",
    method: "POST",
    url: `/api/admin/refunds/${REFUND_ID}/deny`,
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: { reason: "Outside the refund policy window." },
    expectStatus: 200,
  },
  { label: "41 GET /admin/refunds", method: "GET", url: "/api/admin/refunds", headers: SUPER_HEADERS, expectStatus: 200 },
  { label: "42 GET /admin/refunds/:id", method: "GET", url: `/api/admin/refunds/${REFUND_ID}`, headers: SUPER_HEADERS, expectStatus: 200 },

  // ── §4.2 platform-ops promos (routes 43-47) ──
  { label: "43 GET /admin/promos", method: "GET", url: "/api/admin/promos", headers: SUPER_HEADERS, expectStatus: 200 },
  { label: "44 GET /admin/promos/:id", method: "GET", url: `/api/admin/promos/${PROMO_ID}`, headers: SUPER_HEADERS, expectStatus: 200 },
  {
    label: "45 POST /admin/promos",
    method: "POST",
    url: "/api/admin/promos",
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: {
      code: "FALL25",
      stripeCouponId: "coupon_fall25",
      stripePromotionCodeId: "promo_fall25",
      kind: "percent_off",
      percentOff: 25,
      duration: "once",
    },
    expectStatus: 201,
  },
  {
    label: "46 PATCH /admin/promos/:id",
    method: "PATCH",
    url: `/api/admin/promos/${PROMO_ID}`,
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: { maxRedemptions: 500 },
    expectStatus: 200,
  },
  {
    label: "47 POST /admin/promos/:id/deactivate",
    method: "POST",
    url: `/api/admin/promos/${PROMO_ID}/deactivate`,
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: {},
    expectStatus: 200,
  },

  // ── §4.2 platform-ops revenue (routes 48-50) ──
  { label: "48 GET /admin/revenue/snapshots", method: "GET", url: "/api/admin/revenue/snapshots", headers: SUPER_HEADERS, expectStatus: 200 },
  { label: "49 GET /admin/revenue/current", method: "GET", url: "/api/admin/revenue/current", headers: SUPER_HEADERS, expectStatus: 200 },
  {
    label: "50 POST /admin/revenue/snapshots/compute",
    method: "POST",
    url: "/api/admin/revenue/snapshots/compute",
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: {},
    expectStatus: 200,
  },

  // ── §4.2 platform-ops usage + stripe (routes 51-53) ──
  { label: "51 GET /admin/usage/:organizationId/current", method: "GET", url: `/api/admin/usage/${USAGE_ORG_ID}/current`, headers: SUPER_HEADERS, expectStatus: 200 },
  { label: "52 GET /admin/webhooks/stripe/recent", method: "GET", url: "/api/admin/webhooks/stripe/recent", headers: SUPER_HEADERS, expectStatus: 200 },
  {
    label: "53 POST /admin/webhooks/stripe/replay/:eventId",
    method: "POST",
    url: `/api/admin/webhooks/stripe/replay/${WEBHOOK_EVENT_ID}`,
    headers: { ...SUPER_HEADERS, ...IDEMP() },
    payload: {},
    expectStatus: 200,
  },

  // ── §4.3 webhook surface (route 54) — no session/permission gate by design (Stripe-Signature HMAC) ──
  {
    label: "54 POST /v1/webhooks/stripe",
    method: "POST",
    url: "/api/v1/webhooks/stripe",
    headers: { "stripe-signature": "t=1,v1=fake_sig" },
    payload: { id: WEBHOOK_EVENT_ID, type: "invoice.paid" },
    expectStatus: 200,
  },
];

describe.each(ROUTE_CASES)("M35 route smoke — $label", (c) => {
  it(`reaches its handler and returns ${c.expectStatus}`, async () => {
    const { app } = makeServer();
    const res = await app.inject({ method: c.method, url: c.url, headers: c.headers, payload: c.payload });
    expect(res.statusCode).toBe(c.expectStatus);
    await app.close();
  });
});

// ── the §4.2 platform-ops surface is refused for a caller holding the permission key but NO platform-ops
// role — proves `platform_billing_scope` actually runs (RBAC alone is not enough for /api/admin). ─────────
describe("M35 route smoke — the /api/admin `platform_billing_scope` lock", () => {
  it("403s a tenant-role session holding plan.admin.read but no platform-ops role", async () => {
    const backend = createM35Backend();
    const grantStore = createInMemoryEffectivePermissionStore([
      { orgId: ORG, userId: "tenant_admin_1", grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ["plan.admin.read"] }] },
    ]);
    registerEffectivePermissionResolver(grantStore.store);
    const reg = createPredicateRegistry();
    for (const [name, predicate] of Object.entries(buildM35AbacPredicates())) reg.register(name, predicate);
    reg.register("step_up_recent", async (context) => context.attributes.stepUpRecent === true);
    registerAbacRegistry(reg);

    const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    mountM35Routes(app, { service: backend.service, webhook: { ingest: fakeIngest } });

    const res = await app.inject({
      method: "GET",
      url: "/api/admin/plans",
      // holds `plan.admin.read` (RBAC passes) but the role is a tenant role, not a platform-ops one.
      headers: { "x-test-user": "tenant_admin_1", "x-test-org": ORG, "x-test-roles": "org_admin" },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
