// apps/backend/src/modules/35-subscription/routes/service-drizzle.ts — the Drizzle-backed M35RouteService
// (§4.1 tenant + §4.2 admin + §4.3 webhook-adjacent reads). Implements {@link M35RouteService}.
//
// TENANT methods run inside ONE `withOrgContext(db, {organizationId, userId}, …)` transaction on the
// PRIMARY so Postgres RLS scopes each statement to `app.org_id` (the M27 write-service-drizzle precedent);
// writes bind `userId = membershipId` so the M4 write-audit trigger stamps the acting principal. The
// §4.11 `m35.*` events are emitted through the injected {@link WriteOutboxPort} in the SAME unit of work as
// the mutation (transactional outbox). The outbound Stripe calls follow the §4.13 outbox-only path — a
// mutating route persists its local state row and emits an `m35.*` event; the (deferred) stripe-dispatcher
// worker drains the outbox and calls Stripe. M35 carries NO PHI (§8.5); money is INTEGER CENTS.
//
// PLATFORM-OPS methods (`admin*` / refunds / promos / revenue / webhooks) read/write ACROSS tenants under a
// platform credential — they run through the injected {@link PlatformRunner}. The composition root binds it
// to M1's gated `withPlatformContext` (the M34 platform-runner precedent); until a platform pool is bound
// it fails closed (PLATFORM_CONTEXT_UNAVAILABLE), never silently reading nothing under tenant RLS.
import { type DbClient, schema } from "@wardenx/db";
import {
  PaymentMethodRejectedError,
  type PaymentMethodVerifier,
  type RefundRequestCheck,
  type VerifiedPaymentMethod,
  checkRefundRequest,
  committedRefundCents,
} from "@wardenx/subscription-billing";
import { withOrgContext } from "@wardenx/tenancy";
import {
  ConflictError,
  NotFoundError,
  type OrganizationReader,
  WardenXError,
} from "@wardenx/types";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { M35ReadActor, M35WriteActor } from "./actor";
import { type CursorPage, decodeCursor, encodeCursor, pageSizeOf } from "./concurrency";
import { redeemPromoInTx } from "./promo-redemption";
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
} from "./service";

/** The structural org-context transaction handle the queries run through (mirrors M27's WriteTx). */
export type WriteTx = DbClient;

/**
 * The §4.11 `m35.*` transactional-outbox emitter — the composition-root-bound publisher (callerModule
 * `m35` preset). `publish` writes the `outbox_event` row on the caller's tx so it commits atomically with
 * the mutation; the dispatcher Value.Check's the payload against the registered catalog schema. Optional —
 * best-effort until the publisher binds.
 */
export interface WriteOutboxPort {
  publish(
    tx: unknown,
    input: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      /** `null` publishes PLATFORM-WIDE (e.g. the monthly revenue snapshot, which belongs to no tenant). */
      readonly organizationId: string | null;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

/**
 * The gated cross-tenant runner the platform-ops methods execute under. The composition root binds it to
 * M1's `withPlatformContext(platformDb, caller, auditor, fn)` (the M34 precedent). The default fails
 * closed: a platform-ops route refuses (503) rather than reading nothing under tenant RLS.
 */
export type PlatformRunner = <T>(fn: (tx: WriteTx) => Promise<T>) => Promise<T>;

const failClosedPlatformRunner: PlatformRunner = async () => {
  throw new WardenXError(
    "PLATFORM_CONTEXT_UNAVAILABLE",
    "the platform-ops billing surface requires a bound platform credential",
    503,
  );
};

/** Deps the production M35 route service binds at boot — every cross-boundary edge is a port. */
export interface M35RouteServiceDeps {
  readonly outbox?: WriteOutboxPort;
  readonly platformRunner?: PlatformRunner;
  /** M2 `OrganizationReader` seam — labels cross-tenant platform-ops list rows with an org display NAME
   *  (M35A-T03). Absent → names resolve to "" (the console falls back to the raw id); never fabricated. */
  readonly organizationReader?: OrganizationReader;
  /**
   * GAP-060 - verifies a client-supplied `stripePaymentMethodId` against Stripe (it must be attached to THIS
   * org's customer). Unset => attaching a payment method fails closed (503): nothing is trusted from the body.
   */
  readonly paymentMethodVerifier?: PaymentMethodVerifier;
  readonly now?: () => Date;
}

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const isoReq = (d: Date): string => d.toISOString();
const dateOnly = (d: Date | null | undefined): string | null =>
  d ? d.toISOString().slice(0, 10) : null;

// ── row → view mappers ──────────────────────────────────────────────────────────────────────────────────

type PlanRow = typeof schema.plan.$inferSelect;
type MeterRow = typeof schema.planMeter.$inferSelect;
type SubRow = typeof schema.subscriptionRow.$inferSelect;
type PmRow = typeof schema.paymentMethod.$inferSelect;
type InvRow = typeof schema.invoice.$inferSelect;
type RefundRow = typeof schema.refund.$inferSelect;
type PromoRow = typeof schema.promoCode.$inferSelect;
type SnapRow = typeof schema.revenueRecognitionSnapshot.$inferSelect;
type DunRow = typeof schema.dunningStateRow.$inferSelect;
type AggRow = typeof schema.usagePeriodAggregate.$inferSelect;
type WhRow = typeof schema.stripeWebhookEvent.$inferSelect;

function planCatalogView(planIn: PlanRow | undefined, meters: MeterRow[]): PlanCatalogView {
  const plan = req(planIn, "plan");
  return {
    slug: plan.slug,
    name: plan.name,
    description: plan.description,
    tier: plan.tier as PlanCatalogView["tier"],
    cadence: plan.cadence as PlanCatalogView["cadence"],
    basePriceCents: plan.basePriceCents,
    currencyCode: plan.currencyCode,
    trialPeriodDays: plan.trialPeriodDays,
    meters: meters.map((m) => ({
      eventType: m.eventType,
      label: m.eventType,
      inclusiveQuantity: m.inclusiveQuantity,
      overageUnitPriceCents: m.overageUnitPriceCents,
      billingAggregation: m.billingAggregation,
    })),
  };
}

function planAdminView(planIn: PlanRow | undefined, meters: MeterRow[]): PlanAdminView {
  const plan = req(planIn, "plan");
  return {
    ...planCatalogView(plan, meters),
    id: plan.id,
    isActive: plan.isActive,
    deprecatedAt: iso(plan.deprecatedAt),
    stripeProductId: plan.stripeProductId,
    stripePriceId: plan.stripePriceId,
  };
}

function meterView(mIn: MeterRow | undefined): MeterAdminView {
  const m = req(mIn, "meter");
  return {
    id: m.id,
    planId: m.planId,
    eventType: m.eventType,
    label: m.eventType,
    inclusiveQuantity: m.inclusiveQuantity,
    overageUnitPriceCents: m.overageUnitPriceCents,
    billingAggregation: m.billingAggregation,
    warningThresholdPercent: m.warningThresholdPercent,
  };
}

/** GAP-061 — map a failed {@link checkRefundRequest} onto the typed error the route replies with. */
function refundRejection(verdict: Extract<RefundRequestCheck, { ok: false }>): WardenXError {
  if (verdict.reason === "invoice_not_paid") {
    return new WardenXError("REFUND_INVOICE_NOT_PAID", "only a paid invoice can be refunded", 422);
  }
  if (verdict.reason === "amount_invalid") {
    return new WardenXError(
      "VALIDATION_FAILED",
      "the refund amount must be a positive integer",
      400,
    );
  }
  return new WardenXError(
    "REFUND_EXCEEDS_REFUNDABLE",
    `the refund exceeds what remains refundable on the invoice (${verdict.refundableCents} cents)`,
    422,
  );
}

/** Narrow a `.returning()` / point-read result, or fail (a write must return exactly one row). */
function req<T>(row: T | undefined, what = "row"): T {
  if (row === undefined)
    throw new WardenXError("PERSIST_FAILED", `expected a ${what} but got none`, 500);
  return row;
}

function subscriptionView(
  sub: SubRow,
  plan: PlanRow | null,
  pm: PmRow | null,
  dunningStage: SubscriptionView["dunningStage"],
): SubscriptionView {
  return {
    id: sub.id,
    organizationId: sub.organizationId,
    planSlug: plan?.slug ?? "",
    planName: plan?.name ?? "",
    status: sub.status as SubscriptionView["status"],
    trialEndsAt: iso(sub.trialEndsAt),
    currentPeriodStart: iso(sub.currentPeriodStart),
    currentPeriodEnd: iso(sub.currentPeriodEnd),
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    canceledAt: iso(sub.canceledAt),
    defaultPaymentMethodLast4: pm?.cardLast4 ?? pm?.achAccountLast4 ?? pm?.sepaLast4 ?? null,
    defaultPaymentMethodBrand: pm?.cardBrand ?? null,
    defaultPaymentMethodExpiresAt: dateOnly(pm?.expiresAt),
    dunningStage,
  };
}

function subscriptionAdminView(
  sub: SubRow,
  plan: PlanRow | null,
  pm: PmRow | null,
  dunningStage: SubscriptionView["dunningStage"],
  organizationName: string,
): SubscriptionAdminView {
  return {
    ...subscriptionView(sub, plan, pm, dunningStage),
    planTier: (plan?.tier ?? "starter") as SubscriptionAdminView["planTier"],
    stripeSubscriptionId: sub.stripeSubscriptionId,
    startedAt: isoReq(sub.startedAt),
    organizationName,
  };
}

function paymentMethodView(pmIn: PmRow | undefined): PaymentMethodView {
  const pm = req(pmIn, "payment method");
  return {
    id: pm.id,
    kind: pm.kind,
    brand: pm.cardBrand ?? null,
    last4: pm.cardLast4 ?? pm.achAccountLast4 ?? pm.sepaLast4 ?? null,
    expiresAt: dateOnly(pm.expiresAt),
    isDefault: pm.isDefault,
    isActive: pm.isActive,
  };
}

function invoiceListItemView(inv: InvRow): InvoiceListItemView {
  return {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    status: inv.status as InvoiceListItemView["status"],
    totalCents: inv.totalCents,
    currencyCode: inv.currencyCode,
    periodStart: iso(inv.periodStart),
    periodEnd: iso(inv.periodEnd),
    issuedAt: iso(inv.issuedAt),
    dueAt: iso(inv.dueAt),
    paidAt: iso(inv.paidAt),
  };
}

function refundView(rIn: RefundRow | undefined, organizationName: string): RefundView {
  const r = req(rIn, "refund");
  return {
    id: r.id,
    organizationId: r.organizationId,
    organizationName,
    invoiceId: r.invoiceId,
    amountCents: r.amountCents,
    kind: r.kind as RefundView["kind"],
    reasonCode: r.reasonCode,
    status: r.status as RefundView["status"],
    requestedByMembershipId: r.requestedByMembershipId,
    requestedAt: isoReq(r.requestedAt),
    approvedByMembershipId: r.approvedByMembershipId,
    approvedAt: iso(r.approvedAt),
    deniedReason: r.deniedReason,
    executedAt: iso(r.executedAt),
    stripeRefundId: r.stripeRefundId,
  };
}

function promoView(pIn: PromoRow | undefined): PromoView {
  const p = req(pIn, "promo");
  return {
    id: p.id,
    code: p.code,
    kind: p.kind,
    percentOff: p.percentOff,
    fixedOffCents: p.fixedOffCents,
    duration: p.duration,
    durationInMonths: p.durationInMonths,
    validFrom: iso(p.validFrom),
    validTo: iso(p.validTo),
    maxRedemptions: p.maxRedemptions,
    redemptionCount: p.redemptionCount,
    isActive: p.isActive,
  };
}

function snapshotView(sIn: SnapRow | undefined): RevenueSnapshotView {
  const s = req(sIn, "snapshot");
  return {
    id: s.id,
    snapshotMonth: s.snapshotMonth,
    mrrCents: s.mrrCents,
    arrCents: s.arrCents,
    newMrrCents: s.newMrrCents,
    expansionMrrCents: s.expansionMrrCents,
    contractionMrrCents: s.contractionMrrCents,
    churnMrrCents: s.churnMrrCents,
    activeSubscriptions: s.activeSubscriptions,
    trialingSubscriptions: s.trialingSubscriptions,
    pastDueSubscriptions: s.pastDueSubscriptions,
    computedAt: isoReq(s.computedAt),
  };
}

function webhookReceiptView(w: WhRow): WebhookReceiptView {
  return {
    stripeEventId: w.id,
    eventType: w.eventType,
    receivedAt: isoReq(w.receivedAt),
    processedAt: iso(w.processedAt),
    processingAttemptCount: w.processingAttemptCount,
    derivedOrganizationId: w.derivedOrganizationId,
  };
}

/** Keyset page from a DESC-sorted `(createdAt, id)` row list already read from the DB. */
function pageOf<T extends { readonly id: string }>(
  rows: T[],
  keyOf: (row: T) => string,
  cursor: string | undefined,
  limit: number | undefined,
): CursorPage<T> {
  const size = pageSizeOf(limit);
  let start = 0;
  if (cursor) {
    const key = decodeCursor(cursor);
    start = rows.findIndex(
      (r) => keyOf(r) < key.createdAt || (keyOf(r) === key.createdAt && r.id < key.id),
    );
    if (start === -1) start = rows.length;
  }
  const slice = rows.slice(start, start + size);
  const hasMore = start + size < rows.length;
  const last = slice[slice.length - 1];
  return {
    items: slice,
    nextCursor: hasMore && last ? encodeCursor({ createdAt: keyOf(last), id: last.id }) : null,
    hasMore,
  };
}

/**
 * Build the Drizzle-backed {@link M35RouteService} over a `db` handle + the boot-bound ports. Tenant
 * methods scope to `actor.organizationId` under RLS; platform-ops methods run through `platformRunner`.
 */
export function buildDrizzleM35RouteService(
  db: DbClient,
  deps: M35RouteServiceDeps = {},
): M35RouteService {
  const now = deps.now ?? (() => new Date());
  const platform = deps.platformRunner ?? failClosedPlatformRunner;
  const S = schema.subscriptionRow;
  const PL = schema.plan;
  const PM = schema.paymentMethod;
  const INV = schema.invoice;
  const IL = schema.invoiceLine;
  const AGG = schema.usagePeriodAggregate;
  const DUN = schema.dunningStateRow;
  const REF = schema.refund;
  const PROMO = schema.promoCode;
  const PAPP = schema.promoCodeApplication;
  const SNAP = schema.revenueRecognitionSnapshot;
  const WH = schema.stripeWebhookEvent;
  const SH = schema.subscriptionStateHistory;
  const PMTR = schema.planMeter;

  const ctxRead = (a: M35ReadActor) => ({ organizationId: a.organizationId, userId: a.userId });
  // The M4 write-audit trigger stamps `actor_user_id` from `app.user_id`, which is a foreign key to `user(id)`.
  // A MEMBERSHIP id is never a user id, so binding it here made every audited tenant write (payment methods,
  // subscriptions, ...) fail with an FK violation in a real database. The membership is still stamped on the
  // rows that carry it explicitly (`actorMembershipId`, `requestedByMembershipId`, ...).
  const ctxWrite = (a: M35WriteActor) => ({
    organizationId: a.organizationId,
    userId: a.userId,
  });

  const emit = async (
    tx: unknown,
    eventName: string,
    payload: Record<string, unknown>,
    organizationId: string,
    aggregateKind: string,
    aggregateId: string,
  ): Promise<void> => {
    if (deps.outbox) {
      await deps.outbox.publish(tx, {
        eventName,
        payload,
        organizationId,
        aggregateKind,
        aggregateId,
      });
    }
  };

  /** Read the OPEN dunning stage for a subscription (`exited_at IS NULL`), defaulting to `none`. */
  async function openDunningStage(
    tx: WriteTx,
    subscriptionId: string,
  ): Promise<SubscriptionView["dunningStage"]> {
    const [row] = await tx
      .select({ stage: DUN.stage })
      .from(DUN)
      .where(and(eq(DUN.subscriptionId, subscriptionId), isNull(DUN.exitedAt)))
      .limit(1);
    return (row?.stage ?? "none") as SubscriptionView["dunningStage"];
  }

  async function loadPlan(tx: WriteTx, planId: string): Promise<PlanRow | null> {
    const [row] = await tx.select().from(PL).where(eq(PL.id, planId)).limit(1);
    return row ?? null;
  }

  async function loadDefaultPm(tx: WriteTx, sub: SubRow): Promise<PmRow | null> {
    if (!sub.defaultPaymentMethodId) return null;
    const [row] = await tx.select().from(PM).where(eq(PM.id, sub.defaultPaymentMethodId)).limit(1);
    return row ?? null;
  }

  /**
   * Resolve org id → display name via the M2 `OrganizationReader` seam (M35A-T03), batched to avoid N+1.
   * The reader owns its own (non-org-scoped) db handle, so this is safe to call inside a platform-context
   * block. Absent reader / unresolved id → the id is simply absent from the map; the caller falls back to "".
   */
  async function orgNameMap(orgIds: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(orgIds.filter((id) => id.length > 0))];
    if (ids.length === 0 || !deps.organizationReader) return new Map();
    const rows = await deps.organizationReader.readByIds(ids);
    return new Map(rows.map((r) => [r.organizationId, r.displayName]));
  }

  /** Single-org convenience over {@link orgNameMap}: the display name, or "" when unresolved. */
  async function orgNameOf(orgId: string): Promise<string> {
    return (await orgNameMap([orgId])).get(orgId) ?? "";
  }

  return {
    // ── tenant reads ────────────────────────────────────────────────────────────────────────────────
    async listActivePlans() {
      const plans = await db
        .select()
        .from(PL)
        .where(eq(PL.isActive, true))
        .orderBy(PL.basePriceCents);
      const out: PlanCatalogView[] = [];
      for (const plan of plans) {
        const meters = await db.select().from(PMTR).where(eq(PMTR.planId, plan.id));
        out.push(planCatalogView(plan, meters));
      }
      return out;
    },

    async getSubscription(actor) {
      return withOrgContext(db, ctxRead(actor), async (tx) => {
        const [sub] = await tx
          .select()
          .from(S)
          .where(eq(S.organizationId, actor.organizationId))
          .orderBy(desc(S.startedAt))
          .limit(1);
        if (!sub) return null;
        const plan = await loadPlan(tx, sub.planId);
        const pm = await loadDefaultPm(tx, sub);
        return subscriptionView(sub, plan, pm, await openDunningStage(tx, sub.id));
      });
    },

    async listPaymentMethods(actor) {
      return withOrgContext(db, ctxRead(actor), async (tx) => {
        const rows = await tx
          .select()
          .from(PM)
          .where(and(eq(PM.organizationId, actor.organizationId), eq(PM.isActive, true)))
          .orderBy(desc(PM.attachedAt));
        return rows.map(paymentMethodView);
      });
    },

    async listInvoices(actor, cursor, limit) {
      return withOrgContext(db, ctxRead(actor), async (tx) => {
        const rows = await tx
          .select()
          .from(INV)
          .where(eq(INV.organizationId, actor.organizationId))
          .orderBy(desc(INV.lastSyncedAt), desc(INV.id));
        const page = pageOf(rows, (r) => isoReq(r.lastSyncedAt), cursor, limit);
        return {
          items: page.items.map(invoiceListItemView),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        };
      });
    },

    async getInvoice(actor, invoiceId) {
      return withOrgContext(db, ctxRead(actor), async (tx) => {
        const [inv] = await tx
          .select()
          .from(INV)
          .where(and(eq(INV.organizationId, actor.organizationId), eq(INV.id, invoiceId)))
          .limit(1);
        if (!inv) throw new NotFoundError("invoice not found");
        const lines = await tx.select().from(IL).where(eq(IL.invoiceId, inv.id));
        const detail: InvoiceDetailView = {
          ...invoiceListItemView(inv),
          subtotalCents: inv.subtotalCents,
          taxCents: inv.taxCents,
          amountPaidCents: inv.amountPaidCents,
          lines: lines.map((l) => ({
            id: l.id,
            kind: l.kind,
            description: l.description,
            quantity: l.quantity,
            unitAmountCents: l.unitAmountCents,
            totalCents: l.totalCents,
          })),
        };
        return detail;
      });
    },

    async getInvoiceHostedUrl(actor, invoiceId): Promise<RedirectUrlView> {
      return withOrgContext(db, ctxRead(actor), async (tx) => {
        const [inv] = await tx
          .select({ url: INV.hostedInvoiceUrl })
          .from(INV)
          .where(and(eq(INV.organizationId, actor.organizationId), eq(INV.id, invoiceId)))
          .limit(1);
        if (!inv) throw new NotFoundError("invoice not found");
        return { url: inv.url };
      });
    },

    async getInvoicePdfUrl(actor, invoiceId): Promise<RedirectUrlView> {
      return withOrgContext(db, ctxRead(actor), async (tx) => {
        const [inv] = await tx
          .select({ url: INV.invoicePdfUrl })
          .from(INV)
          .where(and(eq(INV.organizationId, actor.organizationId), eq(INV.id, invoiceId)))
          .limit(1);
        if (!inv) throw new NotFoundError("invoice not found");
        return { url: inv.url };
      });
    },

    async getUsageCurrent(actor): Promise<UsageCurrentView> {
      return withOrgContext(db, ctxRead(actor), async (tx) => {
        const [sub] = await tx
          .select()
          .from(S)
          .where(eq(S.organizationId, actor.organizationId))
          .orderBy(desc(S.startedAt))
          .limit(1);
        if (!sub) throw new NotFoundError("no subscription for org");
        const meters = await tx.select().from(PMTR).where(eq(PMTR.planId, sub.planId));
        const [agg] = await tx
          .select()
          .from(AGG)
          .where(eq(AGG.subscriptionId, sub.id))
          .orderBy(desc(AGG.periodStart))
          .limit(1);
        const periodStart = agg?.periodStart ?? sub.currentPeriodStart ?? now();
        const periodEnd = agg?.periodEnd ?? sub.currentPeriodEnd ?? now();
        return {
          periodStart: isoReq(periodStart),
          periodEnd: isoReq(periodEnd),
          meters: meters.map((m) => {
            const total = agg?.totalQuantity ?? 0;
            const inclusive = m.inclusiveQuantity;
            const overage = Math.max(0, total - inclusive);
            const threshold =
              total >= inclusive
                ? "breached"
                : total >= Math.floor(inclusive * 0.8)
                  ? "warning"
                  : "ok";
            return {
              eventType: m.eventType,
              label: m.eventType,
              totalQuantity: total,
              inclusiveQuantity: inclusive,
              overageQuantity: overage,
              overageUnitPriceCents: m.overageUnitPriceCents,
              projectedOverageCostCents: overage * m.overageUnitPriceCents,
              thresholdState: threshold,
            };
          }),
        };
      });
    },

    async getUsageHistory(actor, cursor, limit): Promise<CursorPage<UsagePeriodView>> {
      return withOrgContext(db, ctxRead(actor), async (tx) => {
        const rows = await tx
          .select()
          .from(AGG)
          .where(eq(AGG.organizationId, actor.organizationId))
          .orderBy(desc(AGG.periodStart), desc(AGG.id));
        const page = pageOf(rows, (r) => isoReq(r.periodStart), cursor, limit);
        return {
          items: page.items.map((a: AggRow) => ({
            periodStart: isoReq(a.periodStart),
            periodEnd: isoReq(a.periodEnd),
            totalQuantity: a.totalQuantity,
            inclusiveQuantity: a.inclusiveQuantity,
            overageQuantity: a.overageQuantity,
          })),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        };
      });
    },

    async getBillingStatus(actor): Promise<BillingStatusView> {
      return withOrgContext(db, ctxRead(actor), async (tx) => {
        const [sub] = await tx
          .select()
          .from(S)
          .where(eq(S.organizationId, actor.organizationId))
          .orderBy(desc(S.startedAt))
          .limit(1);
        if (!sub) {
          return {
            status: "none",
            isBlockedByBilling: false,
            dunningStage: "none",
            daysUntilSuspension: null,
            hasValidPaymentMethod: false,
            paymentMethodExpiresAt: null,
          };
        }
        const stage = await openDunningStage(tx, sub.id);
        const pm = await loadDefaultPm(tx, sub);
        return {
          status: sub.status,
          isBlockedByBilling: sub.status === "suspended",
          dunningStage: stage,
          daysUntilSuspension: null,
          hasValidPaymentMethod: pm?.isActive ?? false,
          paymentMethodExpiresAt: dateOnly(pm?.expiresAt),
        };
      });
    },

    // ── tenant writes ──────────────────────────────────────────────────────────────────────────────
    async createSubscription(actor, args): Promise<SubscriptionView> {
      return withOrgContext(db, ctxWrite(actor), async (tx) => {
        const [existing] = await tx
          .select({ id: S.id })
          .from(S)
          .where(
            and(
              eq(S.organizationId, actor.organizationId),
              or(eq(S.status, "active"), eq(S.status, "trialing"), eq(S.status, "past_due")),
            ),
          )
          .limit(1);
        if (existing) throw new ConflictError("an active subscription already exists for this org");
        const [plan] = await tx
          .select()
          .from(PL)
          .where(and(eq(PL.slug, args.planSlug), eq(PL.isActive, true)))
          .limit(1);
        if (!plan) throw new NotFoundError("plan not found or inactive");
        // GAP-060 - a supplied payment method must be an ACTIVE one of THIS org (the column is a bare uuid
        // with no FK, so nothing else stops another tenant's, or a random, id landing here).
        if (args.paymentMethodId) {
          const [ownPm] = await tx
            .select({ id: PM.id })
            .from(PM)
            .where(
              and(
                eq(PM.id, args.paymentMethodId),
                eq(PM.organizationId, actor.organizationId),
                eq(PM.isActive, true),
              ),
            )
            .limit(1);
          if (!ownPm) {
            throw new WardenXError(
              "PAYMENT_METHOD_NOT_FOUND",
              "the payment method does not belong to this organization",
              422,
            );
          }
        }
        const at = now();
        const status = plan.trialPeriodDays > 0 ? "trialing" : "active";
        const trialEndsAt =
          plan.trialPeriodDays > 0
            ? new Date(at.getTime() + plan.trialPeriodDays * 86400000)
            : null;
        const [sub] = await tx
          .insert(S)
          .values({
            organizationId: actor.organizationId,
            planId: plan.id,
            status,
            trialEndsAt,
            defaultPaymentMethodId: args.paymentMethodId ?? null,
            startedAt: at,
          })
          .returning();
        if (!sub) throw new WardenXError("PERSIST_FAILED", "the write returned no row", 500);
        await tx.insert(SH).values({
          subscriptionId: sub.id,
          organizationId: actor.organizationId,
          fromStatus: null,
          toStatus: status,
          transitionedAt: at,
          actorMembershipId: actor.membershipId,
          reasonCode: "tenant_self_service_create",
        });
        await emit(
          tx,
          "m35.subscription.created",
          {
            subscriptionId: sub.id,
            organizationId: actor.organizationId,
            planSlug: plan.slug,
            startedAt: isoReq(at),
          },
          actor.organizationId,
          "subscription",
          sub.id,
        );
        return subscriptionView(sub, plan, null, "none");
      });
    },

    async changePlan(actor, args: ChangePlanArgs): Promise<SubscriptionView> {
      return withOrgContext(db, ctxWrite(actor), async (tx) => {
        const [sub] = await tx
          .select()
          .from(S)
          .where(eq(S.organizationId, actor.organizationId))
          .orderBy(desc(S.startedAt))
          .limit(1);
        if (!sub) throw new NotFoundError("no subscription for org");
        const fromPlan = await loadPlan(tx, sub.planId);
        const [toPlan] = await tx
          .select()
          .from(PL)
          .where(and(eq(PL.slug, args.newPlanSlug), eq(PL.isActive, true)))
          .limit(1);
        if (!toPlan) throw new NotFoundError("target plan not found or inactive");
        // §4.8 plan_change_within_period_grace re-asserted server-side: outside the 7-day grace, only a
        // platform_admin may pass `always_invoice`. A tenant self-service change is never platform_admin.
        if (args.prorationBehavior === "always_invoice") {
          const startMs = sub.currentPeriodStart?.getTime() ?? null;
          const withinGrace = startMs !== null && now().getTime() - startMs <= 7 * 86400000;
          if (!withinGrace && !actor.roles.includes("platform_admin")) {
            throw new WardenXError(
              "PLAN_CHANGE_OUTSIDE_GRACE",
              "always_invoice proration outside the 7-day grace window requires platform_admin",
              403,
            );
          }
        }
        await tx.update(S).set({ planId: toPlan.id, updatedAt: now() }).where(eq(S.id, sub.id));
        await emit(
          tx,
          "m35.subscription.plan_changed",
          {
            subscriptionId: sub.id,
            organizationId: actor.organizationId,
            fromPlanSlug: fromPlan?.slug ?? "",
            toPlanSlug: toPlan.slug,
            prorationBehavior: args.prorationBehavior,
            effectiveAt: isoReq(now()),
          },
          actor.organizationId,
          "subscription",
          sub.id,
        );
        const pm = await loadDefaultPm(tx, sub);
        return subscriptionView(
          { ...sub, planId: toPlan.id },
          toPlan,
          pm,
          await openDunningStage(tx, sub.id),
        );
      });
    },

    async cancelSubscription(actor): Promise<SubscriptionView> {
      return withOrgContext(db, ctxWrite(actor), async (tx) => {
        const [sub] = await tx
          .select()
          .from(S)
          .where(eq(S.organizationId, actor.organizationId))
          .orderBy(desc(S.startedAt))
          .limit(1);
        if (!sub) throw new NotFoundError("no subscription for org");
        const at = now();
        await tx
          .update(S)
          .set({ cancelAtPeriodEnd: true, canceledAt: at, updatedAt: at })
          .where(eq(S.id, sub.id));
        await emit(
          tx,
          "m35.subscription.canceled",
          {
            subscriptionId: sub.id,
            organizationId: actor.organizationId,
            canceledAt: isoReq(at),
            reasonCode: "tenant_requested",
            atPeriodEnd: true,
          },
          actor.organizationId,
          "subscription",
          sub.id,
        );
        const plan = await loadPlan(tx, sub.planId);
        const pm = await loadDefaultPm(tx, sub);
        return subscriptionView(
          { ...sub, cancelAtPeriodEnd: true, canceledAt: at },
          plan,
          pm,
          await openDunningStage(tx, sub.id),
        );
      });
    },

    async resumeSubscription(actor): Promise<SubscriptionView> {
      return withOrgContext(db, ctxWrite(actor), async (tx) => {
        const [sub] = await tx
          .select()
          .from(S)
          .where(eq(S.organizationId, actor.organizationId))
          .orderBy(desc(S.startedAt))
          .limit(1);
        if (!sub) throw new NotFoundError("no subscription for org");
        const at = now();
        const toStatus = sub.status === "paused" ? "active" : sub.status;
        await tx
          .update(S)
          .set({
            status: toStatus,
            cancelAtPeriodEnd: false,
            pausedAt: null,
            pausedUntil: null,
            updatedAt: at,
          })
          .where(eq(S.id, sub.id));
        await emit(
          tx,
          "m35.subscription.resumed",
          { subscriptionId: sub.id, organizationId: actor.organizationId, resumedAt: isoReq(at) },
          actor.organizationId,
          "subscription",
          sub.id,
        );
        const plan = await loadPlan(tx, sub.planId);
        const pm = await loadDefaultPm(tx, sub);
        return subscriptionView(
          { ...sub, status: toStatus, cancelAtPeriodEnd: false },
          plan,
          pm,
          await openDunningStage(tx, sub.id),
        );
      });
    },

    async applyPromoTenant(actor, promoCode): Promise<PromoApplicationView> {
      // GAP-099 — the promo is a platform-shared catalog row `wardenx_app` can only SELECT, so the lock +
      // count increment run on the platform tx. The subscription is derived HERE from the verified actor
      // org (never from the request), and the application is written for that org explicitly.
      return platform(async (tx) => {
        const [sub] = await tx
          .select()
          .from(S)
          .where(eq(S.organizationId, actor.organizationId))
          .orderBy(desc(S.startedAt))
          .limit(1);
        if (!sub) throw new NotFoundError("no subscription for org");
        if (sub.status !== "active" && sub.status !== "trialing") {
          throw new ConflictError("subscription is not in a promo-eligible state");
        }
        const { application: app, promoCode: code } = await redeemPromoInTx(tx, {
          code: promoCode,
          organizationId: actor.organizationId,
          subscriptionId: sub.id,
          appliedByMembershipId: actor.membershipId,
          now: now(),
        });
        await emit(
          tx,
          "m35.promo.applied",
          {
            applicationId: app.id,
            organizationId: actor.organizationId,
            subscriptionId: sub.id,
            promoCode: code,
            appliedByMembershipId: actor.membershipId,
          },
          actor.organizationId,
          "promo_code_application",
          app.id,
        );
        return {
          applicationId: app.id,
          subscriptionId: sub.id,
          promoCode: code,
          applied: true,
        };
      });
    },

    async createSetupIntent(_actor): Promise<SetupIntentView> {
      // GAP-100 — no stripe-dispatcher worker exists to provision a SetupIntent (and the webhook ingest is
      // unbound), so `{clientSecret: null, status: "pending"}` was a permanent fake-pending that no poll
      // ever resolves. Refuse 503 until the Stripe transport is bound; nothing is promised.
      throw new WardenXError(
        "STRIPE_DISPATCHER_UNAVAILABLE",
        "card setup is unavailable: the Stripe dispatcher is not configured for this deployment",
        503,
      );
    },

    async attachPaymentMethod(actor, args: AttachPaymentMethodArgs): Promise<PaymentMethodView> {
      // GAP-060 — the id in the body is a CLAIM, never a fact. Resolve this org's Stripe customer, have Stripe
      // confirm the payment method is attached to it (i.e. came out of a completed SetupIntent for it), and
      // mirror Stripe's metadata, not the client's. No verifier bound => refuse rather than trust.
      const verifier = deps.paymentMethodVerifier;
      if (!verifier) {
        throw new WardenXError(
          "STRIPE_UNAVAILABLE",
          "payment methods cannot be attached: the Stripe transport is not configured for this deployment",
          503,
        );
      }
      const customerId = await withOrgContext(db, ctxWrite(actor), async (tx) => {
        const [sub] = await tx
          .select({ stripeCustomerId: S.stripeCustomerId })
          .from(S)
          .where(eq(S.organizationId, actor.organizationId))
          .orderBy(desc(S.startedAt))
          .limit(1);
        return sub?.stripeCustomerId ?? null;
      });
      if (!customerId) {
        throw new ConflictError(
          "this organization has no Stripe customer yet; start a subscription before adding a payment method",
        );
      }
      let verified: VerifiedPaymentMethod;
      try {
        verified = await verifier.verifyAttachable({
          stripeCustomerId: customerId,
          stripePaymentMethodId: args.stripePaymentMethodId,
        });
      } catch (err) {
        if (err instanceof PaymentMethodRejectedError) {
          throw new WardenXError("PAYMENT_METHOD_REJECTED", err.message, 422);
        }
        throw new WardenXError(
          "STRIPE_UNAVAILABLE",
          "the payment method could not be verified with Stripe; try again shortly",
          503,
        );
      }
      return withOrgContext(db, ctxWrite(actor), async (tx) => {
        const at = now();
        const [taken] = await tx
          .select({ id: PM.id })
          .from(PM)
          .where(eq(PM.stripePaymentMethodId, args.stripePaymentMethodId))
          .limit(1);
        if (taken) throw new ConflictError("this payment method is already attached");
        if (args.setAsDefault) {
          await tx
            .update(PM)
            .set({ isDefault: false })
            .where(and(eq(PM.organizationId, actor.organizationId), eq(PM.isDefault, true)));
        }
        const [pm] = await tx
          .insert(PM)
          .values({
            organizationId: actor.organizationId,
            stripePaymentMethodId: args.stripePaymentMethodId,
            kind: verified.kind,
            cardBrand: verified.cardBrand,
            cardLast4: verified.cardLast4,
            cardExpMonth: verified.cardExpMonth,
            cardExpYear: verified.cardExpYear,
            achBankName: verified.achBankName,
            achAccountLast4: verified.achAccountLast4,
            achAccountType: verified.achAccountType,
            sepaCountry: verified.sepaCountry,
            sepaLast4: verified.sepaLast4,
            // The card is valid THROUGH its expiry month: the first instant of the next month is "expired".
            expiresAt:
              verified.cardExpYear !== null && verified.cardExpMonth !== null
                ? new Date(Date.UTC(verified.cardExpYear, verified.cardExpMonth, 1))
                : null,
            isDefault: args.setAsDefault ?? false,
            isActive: true,
            attachedAt: at,
          })
          // The unique index is GLOBAL across tenants and RLS hides the other tenant's row from the lookup
          // above, so a payment method another org already holds surfaces here as a conflict, not a 500.
          .onConflictDoNothing({ target: PM.stripePaymentMethodId })
          .returning();
        if (!pm) throw new ConflictError("this payment method is already attached");
        if (args.setAsDefault) {
          const [sub] = await tx
            .select({ id: S.id })
            .from(S)
            .where(eq(S.organizationId, actor.organizationId))
            .orderBy(desc(S.startedAt))
            .limit(1);
          if (sub)
            await tx
              .update(S)
              .set({ defaultPaymentMethodId: pm.id, updatedAt: at })
              .where(eq(S.id, sub.id));
        }
        await emit(
          tx,
          "m35.payment_method.added",
          {
            paymentMethodId: pm.id,
            organizationId: actor.organizationId,
            kind: pm.kind,
            isDefault: pm.isDefault,
          },
          actor.organizationId,
          "payment_method",
          pm.id,
        );
        return paymentMethodView(pm);
      });
    },

    async setDefaultPaymentMethod(actor, paymentMethodId): Promise<PaymentMethodView> {
      return withOrgContext(db, ctxWrite(actor), async (tx) => {
        const [pm] = await tx
          .select()
          .from(PM)
          .where(and(eq(PM.organizationId, actor.organizationId), eq(PM.id, paymentMethodId)))
          .limit(1);
        if (!pm) throw new NotFoundError("payment method not found");
        const at = now();
        await tx
          .update(PM)
          .set({ isDefault: false })
          .where(and(eq(PM.organizationId, actor.organizationId), eq(PM.isDefault, true)));
        await tx.update(PM).set({ isDefault: true }).where(eq(PM.id, pm.id));
        const [sub] = await tx
          .select({ id: S.id })
          .from(S)
          .where(eq(S.organizationId, actor.organizationId))
          .orderBy(desc(S.startedAt))
          .limit(1);
        if (sub)
          await tx
            .update(S)
            .set({ defaultPaymentMethodId: pm.id, updatedAt: at })
            .where(eq(S.id, sub.id));
        return paymentMethodView({ ...pm, isDefault: true });
      });
    },

    async detachPaymentMethod(actor, paymentMethodId): Promise<AckView> {
      return withOrgContext(db, ctxWrite(actor), async (tx) => {
        const [pm] = await tx
          .select()
          .from(PM)
          .where(and(eq(PM.organizationId, actor.organizationId), eq(PM.id, paymentMethodId)))
          .limit(1);
        if (!pm) throw new NotFoundError("payment method not found");
        const at = now();
        await tx
          .update(PM)
          .set({ isActive: false, isDefault: false, deactivatedAt: at })
          .where(eq(PM.id, pm.id));
        await emit(
          tx,
          "m35.payment_method.removed",
          {
            paymentMethodId: pm.id,
            organizationId: actor.organizationId,
            deactivatedAt: isoReq(at),
          },
          actor.organizationId,
          "payment_method",
          pm.id,
        );
        return { ok: true };
      });
    },

    // ── platform-ops: plans ──────────────────────────────────────────────────────────────────────────
    async adminListPlans() {
      return platform(async (tx) => {
        const plans = await tx.select().from(PL).orderBy(PL.basePriceCents);
        const out: PlanAdminView[] = [];
        for (const plan of plans) {
          const meters = await tx.select().from(PMTR).where(eq(PMTR.planId, plan.id));
          out.push(planAdminView(plan, meters));
        }
        return out;
      });
    },

    async adminGetPlan(planId) {
      return platform(async (tx) => {
        const [plan] = await tx.select().from(PL).where(eq(PL.id, planId)).limit(1);
        if (!plan) throw new NotFoundError("plan not found");
        const meters = await tx.select().from(PMTR).where(eq(PMTR.planId, planId));
        return planAdminView(plan, meters);
      });
    },

    async adminCreatePlan(_actor, args: CreatePlanArgs) {
      return platform(async (tx) => {
        const [plan] = await tx
          .insert(PL)
          .values({
            slug: args.slug,
            name: args.name,
            description: args.description ?? null,
            tier: args.tier,
            cadence: args.cadence,
            basePriceCents: args.basePriceCents,
            currencyCode: args.currencyCode,
            trialPeriodDays: args.trialPeriodDays,
            isActive: false,
          })
          .returning();
        return planAdminView(plan, []);
      });
    },

    async adminUpdatePlan(_actor, planId, args: UpdatePlanArgs) {
      return platform(async (tx) => {
        const [plan] = await tx.select().from(PL).where(eq(PL.id, planId)).limit(1);
        if (!plan) throw new NotFoundError("plan not found");
        if (plan.isActive) throw new ConflictError("only a draft plan may be edited");
        const [updated] = await tx
          .update(PL)
          .set({
            name: args.name ?? plan.name,
            description: args.description ?? plan.description,
            basePriceCents: args.basePriceCents ?? plan.basePriceCents,
            trialPeriodDays: args.trialPeriodDays ?? plan.trialPeriodDays,
            updatedAt: now(),
          })
          .where(eq(PL.id, planId))
          .returning();
        const meters = await tx.select().from(PMTR).where(eq(PMTR.planId, planId));
        return planAdminView(updated, meters);
      });
    },

    async adminActivatePlan(_actor, planId) {
      return platform(async (tx) => {
        const [updated] = await tx
          .update(PL)
          .set({ isActive: true, updatedAt: now() })
          .where(eq(PL.id, planId))
          .returning();
        if (!updated) throw new NotFoundError("plan not found");
        const meters = await tx.select().from(PMTR).where(eq(PMTR.planId, planId));
        return planAdminView(updated, meters);
      });
    },

    async adminDeprecatePlan(_actor, planId) {
      return platform(async (tx) => {
        const [updated] = await tx
          .update(PL)
          .set({ isActive: false, deprecatedAt: now(), updatedAt: now() })
          .where(eq(PL.id, planId))
          .returning();
        if (!updated) throw new NotFoundError("plan not found");
        const meters = await tx.select().from(PMTR).where(eq(PMTR.planId, planId));
        return planAdminView(updated, meters);
      });
    },

    async adminAddMeter(_actor, planId, args: AddMeterArgs) {
      return platform(async (tx) => {
        const [plan] = await tx.select({ id: PL.id }).from(PL).where(eq(PL.id, planId)).limit(1);
        if (!plan) throw new NotFoundError("plan not found");
        const [meter] = await tx
          .insert(PMTR)
          .values({
            planId,
            eventType: args.eventType as MeterRow["eventType"],
            inclusiveQuantity: args.inclusiveQuantity,
            overageUnitPriceCents: args.overageUnitPriceCents,
            billingAggregation: args.billingAggregation,
            warningThresholdPercent: args.warningThresholdPercent ?? 80,
          })
          .returning();
        return meterView(meter);
      });
    },

    async adminUpdateMeter(_actor, planId, meterId, args: UpdateMeterArgs) {
      return platform(async (tx) => {
        const [meter] = await tx
          .select()
          .from(PMTR)
          .where(and(eq(PMTR.planId, planId), eq(PMTR.id, meterId)))
          .limit(1);
        if (!meter) throw new NotFoundError("meter not found");
        const [updated] = await tx
          .update(PMTR)
          .set({
            inclusiveQuantity: args.inclusiveQuantity ?? meter.inclusiveQuantity,
            overageUnitPriceCents: args.overageUnitPriceCents ?? meter.overageUnitPriceCents,
            warningThresholdPercent: args.warningThresholdPercent ?? meter.warningThresholdPercent,
            updatedAt: now(),
          })
          .where(eq(PMTR.id, meterId))
          .returning();
        return meterView(updated);
      });
    },

    // ── platform-ops: subscriptions ────────────────────────────────────────────────────────────────
    async adminListSubscriptions(filters: AdminSubscriptionListFilters, cursor, limit) {
      return platform(async (tx) => {
        const conds = [];
        if (filters.status) conds.push(eq(S.status, filters.status));
        if (filters.organizationId) conds.push(eq(S.organizationId, filters.organizationId));
        const rows = await tx
          .select()
          .from(S)
          .where(conds.length ? and(...conds) : undefined)
          .orderBy(desc(S.startedAt), desc(S.id));
        const page = pageOf(rows, (r) => isoReq(r.startedAt), cursor, limit);
        const names = await orgNameMap(page.items.map((s) => s.organizationId));
        const items: SubscriptionAdminView[] = [];
        for (const sub of page.items) {
          const plan = await loadPlan(tx, sub.planId);
          const pm = await loadDefaultPm(tx, sub);
          items.push(
            subscriptionAdminView(
              sub,
              plan,
              pm,
              await openDunningStage(tx, sub.id),
              names.get(sub.organizationId) ?? "",
            ),
          );
        }
        return { items, nextCursor: page.nextCursor, hasMore: page.hasMore };
      });
    },

    async adminGetSubscription(subscriptionId) {
      return platform(async (tx) => {
        const [sub] = await tx.select().from(S).where(eq(S.id, subscriptionId)).limit(1);
        if (!sub) throw new NotFoundError("subscription not found");
        const plan = await loadPlan(tx, sub.planId);
        const pm = await loadDefaultPm(tx, sub);
        return subscriptionAdminView(
          sub,
          plan,
          pm,
          await openDunningStage(tx, sub.id),
          await orgNameOf(sub.organizationId),
        );
      });
    },

    async adminPauseSubscription(actor, subscriptionId, pausedUntil) {
      return platform(async (tx) => {
        const [sub] = await tx.select().from(S).where(eq(S.id, subscriptionId)).limit(1);
        if (!sub) throw new NotFoundError("subscription not found");
        const at = now();
        const until = pausedUntil ? new Date(pausedUntil) : null;
        await tx
          .update(S)
          .set({ status: "paused", pausedAt: at, pausedUntil: until, updatedAt: at })
          .where(eq(S.id, sub.id));
        await tx.insert(SH).values({
          subscriptionId: sub.id,
          organizationId: sub.organizationId,
          fromStatus: sub.status,
          toStatus: "paused",
          transitionedAt: at,
          actorMembershipId: actor.membershipId,
          reasonCode: "platform_ops_pause",
        });
        await emit(
          tx,
          "m35.subscription.paused",
          {
            subscriptionId: sub.id,
            organizationId: sub.organizationId,
            pausedAt: isoReq(at),
            pausedUntil: iso(until),
          },
          sub.organizationId,
          "subscription",
          sub.id,
        );
        const plan = await loadPlan(tx, sub.planId);
        const pm = await loadDefaultPm(tx, sub);
        return subscriptionAdminView(
          { ...sub, status: "paused", pausedAt: at, pausedUntil: until },
          plan,
          pm,
          await openDunningStage(tx, sub.id),
          await orgNameOf(sub.organizationId),
        );
      });
    },

    async adminResumeSubscription(actor, subscriptionId) {
      return platform(async (tx) => {
        const [sub] = await tx.select().from(S).where(eq(S.id, subscriptionId)).limit(1);
        if (!sub) throw new NotFoundError("subscription not found");
        const at = now();
        await tx
          .update(S)
          .set({ status: "active", pausedAt: null, pausedUntil: null, updatedAt: at })
          .where(eq(S.id, sub.id));
        await tx.insert(SH).values({
          subscriptionId: sub.id,
          organizationId: sub.organizationId,
          fromStatus: sub.status,
          toStatus: "active",
          transitionedAt: at,
          actorMembershipId: actor.membershipId,
          reasonCode: "platform_ops_resume",
        });
        await emit(
          tx,
          "m35.subscription.resumed",
          { subscriptionId: sub.id, organizationId: sub.organizationId, resumedAt: isoReq(at) },
          sub.organizationId,
          "subscription",
          sub.id,
        );
        const plan = await loadPlan(tx, sub.planId);
        const pm = await loadDefaultPm(tx, sub);
        return subscriptionAdminView(
          { ...sub, status: "active" },
          plan,
          pm,
          await openDunningStage(tx, sub.id),
          await orgNameOf(sub.organizationId),
        );
      });
    },

    async adminCancelSubscription(actor, subscriptionId) {
      return platform(async (tx) => {
        const [sub] = await tx.select().from(S).where(eq(S.id, subscriptionId)).limit(1);
        if (!sub) throw new NotFoundError("subscription not found");
        const at = now();
        await tx
          .update(S)
          .set({ status: "canceled", canceledAt: at, cancelAtPeriodEnd: false, updatedAt: at })
          .where(eq(S.id, sub.id));
        await tx.insert(SH).values({
          subscriptionId: sub.id,
          organizationId: sub.organizationId,
          fromStatus: sub.status,
          toStatus: "canceled",
          transitionedAt: at,
          actorMembershipId: actor.membershipId,
          reasonCode: "platform_ops_cancel_immediate",
        });
        await emit(
          tx,
          "m35.subscription.canceled",
          {
            subscriptionId: sub.id,
            organizationId: sub.organizationId,
            canceledAt: isoReq(at),
            reasonCode: "platform_ops",
            atPeriodEnd: false,
          },
          sub.organizationId,
          "subscription",
          sub.id,
        );
        const plan = await loadPlan(tx, sub.planId);
        const pm = await loadDefaultPm(tx, sub);
        return subscriptionAdminView(
          { ...sub, status: "canceled", canceledAt: at },
          plan,
          pm,
          await openDunningStage(tx, sub.id),
          await orgNameOf(sub.organizationId),
        );
      });
    },

    async adminApplyPromo(actor, subscriptionId, promoCode) {
      return platform(async (tx) => {
        const [sub] = await tx.select().from(S).where(eq(S.id, subscriptionId)).limit(1);
        if (!sub) throw new NotFoundError("subscription not found");
        const { application: app, promoCode: code } = await redeemPromoInTx(tx, {
          code: promoCode,
          organizationId: sub.organizationId,
          subscriptionId: sub.id,
          appliedByMembershipId: actor.membershipId,
          now: now(),
        });
        await emit(
          tx,
          "m35.promo.applied",
          {
            applicationId: app.id,
            organizationId: sub.organizationId,
            subscriptionId: sub.id,
            promoCode: code,
            appliedByMembershipId: actor.membershipId,
          },
          sub.organizationId,
          "promo_code_application",
          app.id,
        );
        return {
          applicationId: app.id,
          subscriptionId: sub.id,
          promoCode: code,
          applied: true,
        };
      });
    },

    async adminRevokePromo(actor, subscriptionId, applicationId) {
      return platform(async (tx) => {
        const [app] = await tx
          .select()
          .from(PAPP)
          .where(and(eq(PAPP.id, applicationId), eq(PAPP.subscriptionId, subscriptionId)))
          .limit(1);
        if (!app) throw new NotFoundError("promo application not found");
        await tx
          .update(PAPP)
          .set({ revokedAt: now(), revokedReason: `revoked by ${actor.membershipId}` })
          .where(eq(PAPP.id, applicationId));
        return { ok: true };
      });
    },

    // ── platform-ops: dunning ──────────────────────────────────────────────────────────────────────
    async adminListDunning(filters: DunningListFilters, cursor, limit) {
      return platform(async (tx) => {
        const conds = [isNull(DUN.exitedAt)];
        if (filters.stage) conds.push(eq(DUN.stage, filters.stage));
        const rows = await tx
          .select()
          .from(DUN)
          .where(and(...conds))
          .orderBy(desc(DUN.enteredAt), desc(DUN.id));
        const page = pageOf(rows, (r) => isoReq(r.enteredAt), cursor, limit);
        const names = await orgNameMap(page.items.map((d) => d.organizationId));
        const items: DunningListItemView[] = [];
        for (const d of page.items) {
          const [sub] = await tx.select().from(S).where(eq(S.id, d.subscriptionId)).limit(1);
          const plan = sub ? await loadPlan(tx, sub.planId) : null;
          items.push({
            subscriptionId: d.subscriptionId,
            organizationId: d.organizationId,
            organizationName: names.get(d.organizationId) ?? "",
            planName: plan?.name ?? "",
            subscriptionStatus: (sub?.status ??
              "past_due") as DunningListItemView["subscriptionStatus"],
            stage: d.stage as DunningListItemView["stage"],
            enteredAt: isoReq(d.enteredAt),
            nextAttemptAt: iso(d.nextAttemptAt),
          });
        }
        return { items, nextCursor: page.nextCursor, hasMore: page.hasMore };
      });
    },

    async adminSkipDunningStage(_actor, subscriptionId): Promise<DunningView> {
      return platform(async (tx) => {
        const [open] = await tx
          .select()
          .from(DUN)
          .where(and(eq(DUN.subscriptionId, subscriptionId), isNull(DUN.exitedAt)))
          .limit(1);
        if (!open) throw new NotFoundError("no open dunning state for subscription");
        return {
          subscriptionId,
          stage: open.stage as DunningView["stage"],
          enteredAt: isoReq(open.enteredAt),
          nextAttemptAt: iso(open.nextAttemptAt),
        };
      });
    },

    async adminResetDunning(_actor, subscriptionId): Promise<DunningView> {
      return platform(async (tx) => {
        const at = now();
        await tx
          .update(DUN)
          .set({ exitedAt: at, exitReason: "admin_reset" })
          .where(and(eq(DUN.subscriptionId, subscriptionId), isNull(DUN.exitedAt)));
        await emit(
          tx,
          "m35.dunning.resolved",
          { subscriptionId, organizationId: "", resolvedAt: isoReq(at), lastStage: "resolved" },
          "",
          "subscription",
          subscriptionId,
        ).catch(() => undefined);
        return { subscriptionId, stage: "resolved", enteredAt: isoReq(at), nextAttemptAt: null };
      });
    },

    // ── platform-ops: refunds ──────────────────────────────────────────────────────────────────────
    async requestRefund(actor, args: RequestRefundArgs): Promise<RefundView> {
      return platform(async (tx) => {
        // GAP-061 — lock the invoice row so two concurrent requests serialize on the cumulative cap.
        const [inv] = await tx
          .select()
          .from(INV)
          .where(eq(INV.id, args.invoiceId))
          .limit(1)
          .for("update");
        if (!inv) throw new NotFoundError("invoice not found");
        const prior = await tx
          .select({ status: REF.status, amountCents: REF.amountCents })
          .from(REF)
          .where(eq(REF.invoiceId, inv.id));
        const verdict = checkRefundRequest({
          invoiceStatus: inv.status,
          amountPaidCents: inv.amountPaidCents,
          committedRefundCents: committedRefundCents(prior),
          amountCents: args.amountCents,
        });
        if (!verdict.ok) throw refundRejection(verdict);
        const [ref] = await tx
          .insert(REF)
          .values({
            organizationId: inv.organizationId,
            invoiceId: inv.id,
            amountCents: args.amountCents,
            kind: args.kind,
            reasonCode: args.reasonCode,
            reasonDetail: args.reasonDetail,
            requestedByMembershipId: actor.membershipId,
            requestedAt: now(),
            status: "requested",
          })
          .returning();
        if (!ref) throw new WardenXError("PERSIST_FAILED", "the write returned no row", 500);
        await emit(
          tx,
          "m35.refund.requested",
          {
            refundId: ref.id,
            organizationId: inv.organizationId,
            invoiceId: inv.id,
            amountCents: args.amountCents,
            requestedByMembershipId: actor.membershipId,
            reasonCode: args.reasonCode,
          },
          inv.organizationId,
          "refund",
          ref.id,
        );
        return refundView(ref, await orgNameOf(inv.organizationId));
      });
    },

    async approveRefund(actor, refundId): Promise<RefundView> {
      return platform(async (tx) => {
        const [ref] = await tx.select().from(REF).where(eq(REF.id, refundId)).limit(1);
        if (!ref) throw new NotFoundError("refund not found");
        if (ref.status !== "requested") throw new ConflictError("refund is not in requested state");
        // §4.8 four-eyes: the approver must differ from the requester.
        if (ref.requestedByMembershipId === actor.membershipId) {
          throw new WardenXError(
            "REFUND_FOUR_EYES",
            "the approver must differ from the requester",
            403,
          );
        }
        const at = now();
        const [updated] = await tx
          .update(REF)
          .set({ status: "approved", approvedByMembershipId: actor.membershipId, approvedAt: at })
          .where(eq(REF.id, refundId))
          .returning();
        await emit(
          tx,
          "m35.refund.approved",
          {
            refundId: ref.id,
            organizationId: ref.organizationId,
            approvedByMembershipId: actor.membershipId,
            approvedAt: isoReq(at),
          },
          ref.organizationId,
          "refund",
          ref.id,
        );
        return refundView(updated, await orgNameOf(ref.organizationId));
      });
    },

    async denyRefund(actor, refundId, reason): Promise<RefundView> {
      return platform(async (tx) => {
        const [ref] = await tx.select().from(REF).where(eq(REF.id, refundId)).limit(1);
        if (!ref) throw new NotFoundError("refund not found");
        if (ref.status !== "requested") throw new ConflictError("refund is not in requested state");
        const at = now();
        const [updated] = await tx
          .update(REF)
          .set({
            status: "denied",
            deniedByMembershipId: actor.membershipId,
            deniedAt: at,
            deniedReason: reason,
          })
          .where(eq(REF.id, refundId))
          .returning();
        return refundView(updated, await orgNameOf(ref.organizationId));
      });
    },

    async listRefunds(cursor, limit) {
      return platform(async (tx) => {
        const rows = await tx.select().from(REF).orderBy(desc(REF.requestedAt), desc(REF.id));
        const page = pageOf(rows, (r) => isoReq(r.requestedAt), cursor, limit);
        const names = await orgNameMap(page.items.map((r) => r.organizationId));
        return {
          items: page.items.map((r) => refundView(r, names.get(r.organizationId) ?? "")),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        };
      });
    },

    async adminGetRefund(refundId): Promise<RefundView> {
      return platform(async (tx) => {
        const [ref] = await tx.select().from(REF).where(eq(REF.id, refundId)).limit(1);
        if (!ref) throw new NotFoundError("refund not found");
        return refundView(ref, await orgNameOf(ref.organizationId));
      });
    },

    // ── platform-ops: promos ───────────────────────────────────────────────────────────────────────
    async adminListPromos() {
      return platform(async (tx) => {
        const rows = await tx.select().from(PROMO).orderBy(desc(PROMO.createdAt));
        return rows.map(promoView);
      });
    },

    async adminGetPromo(promoId) {
      return platform(async (tx) => {
        const [promo] = await tx.select().from(PROMO).where(eq(PROMO.id, promoId)).limit(1);
        if (!promo) throw new NotFoundError("promo not found");
        return promoView(promo);
      });
    },

    async adminCreatePromo(_actor, args: CreatePromoArgs) {
      return platform(async (tx) => {
        const [promo] = await tx
          .insert(PROMO)
          .values({
            code: args.code,
            stripeCouponId: args.stripeCouponId,
            stripePromotionCodeId: args.stripePromotionCodeId,
            kind: args.kind,
            percentOff: args.percentOff ?? null,
            fixedOffCents: args.fixedOffCents ?? null,
            duration: args.duration,
            durationInMonths: args.durationInMonths ?? null,
            validFrom: args.validFrom ? new Date(args.validFrom) : null,
            validTo: args.validTo ? new Date(args.validTo) : null,
            maxRedemptions: args.maxRedemptions ?? null,
            isActive: true,
          })
          .returning();
        return promoView(promo);
      });
    },

    async adminUpdatePromo(_actor, promoId, args: UpdatePromoArgs) {
      return platform(async (tx) => {
        const [promo] = await tx.select().from(PROMO).where(eq(PROMO.id, promoId)).limit(1);
        if (!promo) throw new NotFoundError("promo not found");
        const [updated] = await tx
          .update(PROMO)
          .set({
            validTo: args.validTo ? new Date(args.validTo) : promo.validTo,
            maxRedemptions: args.maxRedemptions ?? promo.maxRedemptions,
          })
          .where(eq(PROMO.id, promoId))
          .returning();
        return promoView(updated);
      });
    },

    async adminDeactivatePromo(_actor, promoId) {
      return platform(async (tx) => {
        const [updated] = await tx
          .update(PROMO)
          .set({ isActive: false })
          .where(eq(PROMO.id, promoId))
          .returning();
        if (!updated) throw new NotFoundError("promo not found");
        return promoView(updated);
      });
    },

    // ── platform-ops: revenue ──────────────────────────────────────────────────────────────────────
    async listRevenueSnapshots(cursor, limit) {
      return platform(async (tx) => {
        const rows = await tx.select().from(SNAP).orderBy(desc(SNAP.snapshotMonth), desc(SNAP.id));
        const page = pageOf(rows, (r) => r.snapshotMonth, cursor, limit);
        return {
          items: page.items.map(snapshotView),
          nextCursor: page.nextCursor,
          hasMore: page.hasMore,
        };
      });
    },

    async getCurrentRevenue(): Promise<CurrentRevenueView> {
      return platform(async (tx) => {
        const subs = await tx.select({ status: S.status, planId: S.planId }).from(S);
        let mrr = 0;
        let active = 0;
        for (const sub of subs) {
          if (sub.status === "active" || sub.status === "past_due" || sub.status === "at_risk") {
            const plan = await loadPlan(tx, sub.planId);
            if (plan) {
              mrr +=
                plan.cadence === "annual"
                  ? Math.round(plan.basePriceCents / 12)
                  : plan.basePriceCents;
              active++;
            }
          }
        }
        return {
          mrrCents: mrr,
          arrCents: mrr * 12,
          activeSubscriptions: active,
          asOf: isoReq(now()),
        };
      });
    },

    async recomputeRevenue(_actor): Promise<RevenueSnapshotView> {
      return platform(async (tx) => {
        const at = now();
        const month = `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
        const subs = await tx.select({ status: S.status, planId: S.planId }).from(S);
        let mrr = 0;
        let active = 0;
        let trialing = 0;
        let pastDue = 0;
        for (const sub of subs) {
          if (sub.status === "trialing") trialing++;
          if (sub.status === "past_due") pastDue++;
          if (sub.status === "active" || sub.status === "past_due" || sub.status === "at_risk") {
            const plan = await loadPlan(tx, sub.planId);
            if (plan) {
              mrr +=
                plan.cadence === "annual"
                  ? Math.round(plan.basePriceCents / 12)
                  : plan.basePriceCents;
              active++;
            }
          }
        }
        const [snap] = await tx
          .insert(SNAP)
          .values({
            snapshotMonth: month,
            mrrCents: mrr,
            arrCents: mrr * 12,
            newMrrCents: 0,
            expansionMrrCents: 0,
            contractionMrrCents: 0,
            churnMrrCents: 0,
            activeSubscriptions: active,
            trialingSubscriptions: trialing,
            pastDueSubscriptions: pastDue,
            computedAt: at,
          })
          .onConflictDoUpdate({
            target: SNAP.snapshotMonth,
            set: {
              mrrCents: mrr,
              arrCents: mrr * 12,
              activeSubscriptions: active,
              trialingSubscriptions: trialing,
              pastDueSubscriptions: pastDue,
              computedAt: at,
            },
          })
          .returning();
        return snapshotView(snap);
      });
    },

    // ── platform-ops: usage + stripe ───────────────────────────────────────────────────────────────
    async adminGetTenantUsage(organizationId): Promise<UsageCurrentView> {
      return platform(async (tx) => {
        const [sub] = await tx
          .select()
          .from(S)
          .where(eq(S.organizationId, organizationId))
          .orderBy(desc(S.startedAt))
          .limit(1);
        if (!sub) throw new NotFoundError("no subscription for org");
        const meters = await tx.select().from(PMTR).where(eq(PMTR.planId, sub.planId));
        const [agg] = await tx
          .select()
          .from(AGG)
          .where(eq(AGG.subscriptionId, sub.id))
          .orderBy(desc(AGG.periodStart))
          .limit(1);
        const periodStart = agg?.periodStart ?? sub.currentPeriodStart ?? now();
        const periodEnd = agg?.periodEnd ?? sub.currentPeriodEnd ?? now();
        return {
          periodStart: isoReq(periodStart),
          periodEnd: isoReq(periodEnd),
          meters: meters.map((m) => {
            const total = agg?.totalQuantity ?? 0;
            const overage = Math.max(0, total - m.inclusiveQuantity);
            return {
              eventType: m.eventType,
              label: m.eventType,
              totalQuantity: total,
              inclusiveQuantity: m.inclusiveQuantity,
              overageQuantity: overage,
              overageUnitPriceCents: m.overageUnitPriceCents,
              projectedOverageCostCents: overage * m.overageUnitPriceCents,
              thresholdState:
                total >= m.inclusiveQuantity
                  ? "breached"
                  : total >= Math.floor(m.inclusiveQuantity * 0.8)
                    ? "warning"
                    : "ok",
            };
          }),
        };
      });
    },

    async listRecentWebhooks(cursor, limit) {
      return platform(async (tx) => {
        const rows = await tx.select().from(WH).orderBy(desc(WH.receivedAt));
        // stripe_webhook_event.id is TEXT (the Stripe event id); page on (receivedAt, id).
        const size = pageSizeOf(limit);
        let start = 0;
        if (cursor) {
          const key = decodeCursor(cursor);
          start = rows.findIndex(
            (r) =>
              isoReq(r.receivedAt) < key.createdAt ||
              (isoReq(r.receivedAt) === key.createdAt && r.id < key.id),
          );
          if (start === -1) start = rows.length;
        }
        const slice = rows.slice(start, start + size);
        const hasMore = start + size < rows.length;
        const last = slice[slice.length - 1];
        return {
          items: slice.map(webhookReceiptView),
          nextCursor:
            hasMore && last
              ? encodeCursor({ createdAt: isoReq(last.receivedAt), id: last.id })
              : null,
          hasMore,
        };
      });
    },

    async replayWebhook(_actor, stripeEventId): Promise<AckView> {
      return platform(async (tx) => {
        const [wh] = await tx
          .select({ id: WH.id })
          .from(WH)
          .where(eq(WH.id, stripeEventId))
          .limit(1);
        if (!wh) throw new NotFoundError("webhook event not found");
        // §4.2 last-resort replay: re-emit the internal handler signal so the webhook-handler worker
        // re-processes the (already-persisted, already-verified) event. No re-verification; dedup applies.
        await tx.update(WH).set({ processingAttemptCount: 0 }).where(eq(WH.id, stripeEventId));
        return { ok: true };
      });
    },
  };
}
