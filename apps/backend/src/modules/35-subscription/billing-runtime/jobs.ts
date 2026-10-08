// apps/backend/src/modules/35-subscription/billing-runtime/jobs.ts - GAP-059.
//
// The M35 background jobs that nothing ran before: the dunning ladder, the payment-method expiry watch, the
// usage aggregator, the monthly revenue snapshot and the invoice-sum reconciler. Each is a plain async
// function over explicit deps (no BullMQ here - see ./workers.ts) so it is testable against a real database.
//
// TENANCY. Per-org jobs enter `withOrgContext(db, {organizationId, userId: ""}, ...)` on the tenant pool
// (RLS-scoped, the M35 org-lifecycle consumer pattern); they are fanned out over the active-org enumerator.
// The revenue snapshot is platform-wide (cross-tenant read + a platform-only table) and runs on the
// platform runner. Events go through the catalog-validating `m35` outbox publisher in the SAME transaction
// as the state change, so a lost job never leaves a transition without its event.
import { type DbClient, schema } from "@wardenx/db";
import {
  DUNNING_CANCEL_STAGE,
  DUNNING_SUSPEND_STAGE,
  DunningStateMachineService,
  type OutboxIntent,
  RevenueRecognitionService,
  SubscriptionLifecycleService,
  buildUsageOverageOutbox,
  buildUsagePeriodClosedOutbox,
  canTransitionSubscription,
  computeMeterAggregate,
  invoiceLineSumsConsistent,
  toBillingYearMonth,
} from "@wardenx/subscription-billing";
import { withOrgContext } from "@wardenx/tenancy";
import type {
  BillingYearMonth,
  InvoiceLineKind,
  OrgId,
  SubscriptionStatus,
  UsageEventType,
} from "@wardenx/types";
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { PlatformRunner, WriteOutboxPort } from "../routes/service-drizzle";
import {
  createDrizzleDunningStore,
  createDrizzleRevenueStore,
  createDrizzleSubscriptionStore,
} from "./drizzle-stores";

export interface M35JobDeps {
  /** The TENANT pool (RLS-scoped via `withOrgContext`). */
  readonly db: DbClient;
  readonly platformRunner: PlatformRunner;
  readonly outbox: WriteOutboxPort;
  readonly listOrgs: () => Promise<readonly { readonly organizationId: string }[]>;
  readonly now?: () => Date;
  readonly log?: (message: string, detail: Record<string, unknown>) => void;
}

const nowOf = (deps: M35JobDeps): Date => (deps.now ?? (() => new Date()))();
const MS_PER_DAY = 86_400_000;

type Tx = DbClient;

/** Run `fn` for every org; one org's failure never starves the rest, and the job still FAILS afterwards. */
export async function runM35Fanout(
  deps: Pick<M35JobDeps, "listOrgs" | "log">,
  fn: (organizationId: string) => Promise<void>,
  label: string,
): Promise<void> {
  const errors: unknown[] = [];
  for (const { organizationId } of await deps.listOrgs()) {
    try {
      await fn(organizationId);
    } catch (err) {
      errors.push(err);
      deps.log?.(`m35 ${label} failed for an org`, {
        organizationId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (errors.length > 0)
    throw new AggregateError(errors, `m35 ${label}: ${errors.length} org(s) failed`);
}

function aggregateIdOf(intent: OutboxIntent, fallback: string): string {
  const p = intent.payload as unknown as Record<string, unknown>;
  for (const key of ["subscriptionId", "paymentMethodId", "refundId", "snapshotId"]) {
    if (typeof p[key] === "string") return p[key] as string;
  }
  return fallback;
}

function aggregateKindOf(eventName: string): string {
  return eventName.split(".")[1] ?? "subscription";
}

async function publishIntents(
  outbox: WriteOutboxPort,
  tx: Tx,
  intents: readonly OutboxIntent[],
  organizationId: string | null,
  fallbackAggregateId: string,
): Promise<void> {
  for (const intent of intents) {
    await outbox.publish(tx, {
      eventName: intent.eventName,
      payload: intent.payload as unknown as Record<string, unknown>,
      organizationId,
      aggregateKind: aggregateKindOf(intent.eventName),
      aggregateId: aggregateIdOf(intent, fallbackAggregateId),
    });
  }
}

// ── dunning-engine ──────────────────────────────────────────────────────────────────────────────────────

/** Subscription statuses the ladder walks through on its way to a target (D7 graph has no direct jump). */
const SUSPEND_PATH: readonly SubscriptionStatus[] = ["past_due", "at_risk", "suspended"];
const CANCEL_PATH: readonly SubscriptionStatus[] = ["canceled"];

/**
 * Walk the subscription along `path` from wherever it is, one legal D7 edge at a time. A subscription that is
 * already at/after the target (or terminal) is left alone.
 */
async function driveSubscription(
  deps: M35JobDeps,
  tx: Tx,
  subscriptionId: string,
  organizationId: string,
  path: readonly SubscriptionStatus[],
  stage: typeof DUNNING_SUSPEND_STAGE | typeof DUNNING_CANCEL_STAGE,
  now: Date,
): Promise<void> {
  const store = createDrizzleSubscriptionStore(tx);
  const lifecycle = new SubscriptionLifecycleService(store);
  const current = await store.loadForUpdate(subscriptionId);
  if (!current) return;
  let status = current.status;
  for (const next of path) {
    if (status === next) continue;
    if (!canTransitionSubscription(status, next)) continue;
    const result = await lifecycle.transition({
      subscriptionId,
      toStatus: next,
      actorMembershipId: null,
      reasonCode: `dunning_${stage}`,
      stripeEventId: null,
      dunning: { dunningStage: stage },
      now,
    });
    await publishIntents(deps.outbox, tx, result.outbox, organizationId, subscriptionId);
    status = result.to;
  }
}

/** Advance every OPEN dunning row of one org whose stage interval has elapsed (and drive suspend/cancel). */
export async function runDunningForOrg(deps: M35JobDeps, organizationId: string): Promise<number> {
  const now = nowOf(deps);
  const open = await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) =>
    (scoped as unknown as Tx)
      .select({ subscriptionId: schema.dunningStateRow.subscriptionId })
      .from(schema.dunningStateRow)
      .where(
        and(
          eq(schema.dunningStateRow.organizationId, organizationId),
          isNull(schema.dunningStateRow.exitedAt),
        ),
      ),
  );
  let advanced = 0;
  for (const { subscriptionId } of open) {
    await withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
      const tx = scoped as unknown as Tx;
      const dunning = new DunningStateMachineService(createDrizzleDunningStore(tx));
      const result = await dunning.tick({ subscriptionId: subscriptionId as never, now });
      if (result.from === result.to) return;
      advanced += 1;
      await publishIntents(deps.outbox, tx, result.outbox, organizationId, subscriptionId);
      if (result.sideEffect === "suspend") {
        await driveSubscription(
          deps,
          tx,
          subscriptionId,
          organizationId,
          SUSPEND_PATH,
          DUNNING_SUSPEND_STAGE,
          now,
        );
      } else if (result.sideEffect === "cancel") {
        await driveSubscription(
          deps,
          tx,
          subscriptionId,
          organizationId,
          CANCEL_PATH,
          DUNNING_CANCEL_STAGE,
          now,
        );
      }
    });
  }
  return advanced;
}

// ── payment-method expiry watch ─────────────────────────────────────────────────────────────────────────

/** The §2.4 warning windows (days before expiry) - one `expiring_soon` per window crossing. */
export const PAYMENT_METHOD_EXPIRY_WINDOWS_DAYS: readonly number[] = [30, 14, 7, 1];

/** Days until `expiresAt`, rounded UP so "expires later today" is 1 and the window match is stable. */
export function daysUntil(expiresAt: Date, now: Date): number {
  return Math.ceil((expiresAt.getTime() - now.getTime()) / MS_PER_DAY);
}

export async function runPaymentMethodExpiryForOrg(
  deps: M35JobDeps,
  organizationId: string,
): Promise<{ warned: number; expired: number }> {
  const now = nowOf(deps);
  return withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
    const tx = scoped as unknown as Tx;
    const PM = schema.paymentMethod;
    const rows = await tx
      .select({ id: PM.id, expiresAt: PM.expiresAt })
      .from(PM)
      .where(and(eq(PM.organizationId, organizationId), eq(PM.isActive, true)));
    let warned = 0;
    let expired = 0;
    for (const row of rows) {
      if (!row.expiresAt) continue;
      if (row.expiresAt.getTime() <= now.getTime()) {
        const done = await tx
          .update(PM)
          .set({ isActive: false, deactivatedAt: now })
          .where(and(eq(PM.id, row.id), eq(PM.isActive, true)))
          .returning({ id: PM.id });
        if (done.length === 0) continue;
        expired += 1;
        await deps.outbox.publish(tx, {
          eventName: "m35.payment_method.expired",
          payload: {
            paymentMethodId: row.id,
            organizationId,
            expiredAt: row.expiresAt.toISOString(),
          },
          organizationId,
          aggregateKind: "payment_method",
          aggregateId: row.id,
        });
        continue;
      }
      const days = daysUntil(row.expiresAt, now);
      if (!PAYMENT_METHOD_EXPIRY_WINDOWS_DAYS.includes(days)) continue;
      warned += 1;
      await deps.outbox.publish(tx, {
        eventName: "m35.payment_method.expiring_soon",
        payload: {
          paymentMethodId: row.id,
          organizationId,
          expiresAt: row.expiresAt.toISOString(),
          daysUntilExpiry: days,
        },
        organizationId,
        aggregateKind: "payment_method",
        aggregateId: row.id,
      });
    }
    return { warned, expired };
  });
}

// ── usage aggregator ────────────────────────────────────────────────────────────────────────────────────

interface UsageWindow {
  readonly start: Date;
  readonly end: Date;
}

/** The subscription's billing window containing `now`; calendar month (UTC) when the mirror has no period. */
export function usageWindowFor(
  sub: { currentPeriodStart: Date | null; currentPeriodEnd: Date | null },
  now: Date,
): UsageWindow {
  if (sub.currentPeriodStart && sub.currentPeriodEnd && sub.currentPeriodEnd > now) {
    return { start: sub.currentPeriodStart, end: sub.currentPeriodEnd };
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { start, end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)) };
}

async function meterTotal(
  tx: Tx,
  organizationId: string,
  eventType: UsageEventType,
  aggregation: string,
  window: UsageWindow,
): Promise<number> {
  const UE = schema.usageEvent;
  const scope = and(
    eq(UE.organizationId, organizationId),
    eq(UE.eventType, eventType),
    gte(UE.recordedAt, window.start),
    lt(UE.recordedAt, window.end),
  );
  if (aggregation === "last") {
    const [row] = await tx
      .select({ quantity: UE.quantity })
      .from(UE)
      .where(scope)
      .orderBy(desc(UE.recordedAt))
      .limit(1);
    return Number(row?.quantity ?? 0);
  }
  const [row] = await tx
    .select({
      total:
        aggregation === "count"
          ? sql<string>`count(*)`
          : sql<string>`coalesce(sum(${UE.quantity}), 0)`,
    })
    .from(UE)
    .where(scope);
  return Number(row?.total ?? 0);
}

/** Aggregate usage for the current window (threshold alerts) and finalize the window that just ended. */
export async function runUsageAggregationForOrg(
  deps: M35JobDeps,
  organizationId: string,
): Promise<number> {
  const now = nowOf(deps);
  return withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
    const tx = scoped as unknown as Tx;
    const S = schema.subscriptionRow;
    const AGG = schema.usagePeriodAggregate;
    const subs = await tx
      .select()
      .from(S)
      .where(
        and(
          eq(S.organizationId, organizationId),
          inArray(S.status, ["trialing", "active", "past_due", "at_risk"]),
        ),
      );
    let touched = 0;
    for (const sub of subs) {
      const meters = await tx
        .select()
        .from(schema.planMeter)
        .where(eq(schema.planMeter.planId, sub.planId));
      const current = usageWindowFor(sub, now);
      const previous: UsageWindow = {
        start: new Date(
          current.start.getTime() - (current.end.getTime() - current.start.getTime()),
        ),
        end: current.start,
      };
      for (const [window, finalize] of [
        [previous, true],
        [current, false],
      ] as const) {
        const closedTotals: Array<{ eventType: UsageEventType; totalQuantity: number }> = [];
        let alreadyFinal = true;
        for (const meter of meters) {
          const [existing] = await tx
            .select()
            .from(AGG)
            .where(
              and(
                eq(AGG.subscriptionId, sub.id),
                eq(AGG.eventType, meter.eventType),
                eq(AGG.periodStart, window.start),
                eq(AGG.periodEnd, window.end),
              ),
            )
            .limit(1);
          // A closed window is final once an aggregate computed AT/AFTER its end exists; never recompute it.
          if (finalize && existing && existing.computedAt >= window.end) {
            closedTotals.push({
              eventType: meter.eventType as UsageEventType,
              totalQuantity: existing.totalQuantity,
            });
            continue;
          }
          alreadyFinal = false;
          const total = await meterTotal(
            tx,
            organizationId,
            meter.eventType as UsageEventType,
            meter.billingAggregation,
            window,
          );
          if (finalize && total === 0 && !existing) continue; // no usage, no row: nothing to close
          const agg = computeMeterAggregate({
            totalQuantity: total,
            inclusiveQuantity: meter.inclusiveQuantity,
            overageUnitPriceCents: meter.overageUnitPriceCents,
          });
          const flags = {
            warningEmittedAt: existing?.warningEmittedAt ?? null,
            breachEmittedAt: existing?.breachEmittedAt ?? null,
          };
          if (!finalize) {
            const intents = buildUsageOverageOutbox({
              subscriptionId: sub.id,
              organizationId: organizationId as OrgId,
              eventType: meter.eventType as UsageEventType,
              aggregate: agg,
            });
            for (const intent of intents) {
              const isBreach = intent.eventName === "m35.usage.overage_threshold_breached";
              if (isBreach ? flags.breachEmittedAt : flags.warningEmittedAt) continue;
              await publishIntents(deps.outbox, tx, [intent], organizationId, sub.id);
              if (isBreach) flags.breachEmittedAt = now;
              else flags.warningEmittedAt = now;
            }
          }
          const values = {
            organizationId,
            subscriptionId: sub.id,
            eventType: meter.eventType,
            periodStart: window.start,
            periodEnd: window.end,
            totalQuantity: agg.totalQuantity,
            inclusiveQuantity: agg.inclusiveQuantity,
            overageQuantity: agg.overageQuantity,
            computedAt: now,
            ...flags,
          };
          await tx
            .insert(AGG)
            .values(values)
            .onConflictDoUpdate({
              target: [AGG.subscriptionId, AGG.eventType, AGG.periodStart, AGG.periodEnd],
              set: values,
            });
          touched += 1;
          closedTotals.push({
            eventType: meter.eventType as UsageEventType,
            totalQuantity: agg.totalQuantity,
          });
        }
        if (finalize && !alreadyFinal && closedTotals.length > 0) {
          await publishIntents(
            deps.outbox,
            tx,
            [
              buildUsagePeriodClosedOutbox({
                subscriptionId: sub.id,
                organizationId: organizationId as OrgId,
                periodStart: window.start,
                periodEnd: window.end,
                meterTotals: closedTotals,
              }),
            ],
            organizationId,
            sub.id,
          );
        }
      }
    }
    return touched;
  });
}

// ── monthly revenue snapshot (platform-wide) ────────────────────────────────────────────────────────────

/**
 * Compute and store the snapshot for the month that just ended (the cron fires on the 1st, when "current"
 * subscription state is the ended month's end state). Idempotent: the table is unique on the month.
 */
export async function runRevenueSnapshot(
  deps: M35JobDeps,
): Promise<{ computed: boolean; month: string }> {
  const now = nowOf(deps);
  const month = toBillingYearMonth(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
  ) as BillingYearMonth;
  return deps.platformRunner(async (tx) => {
    const SNAP = schema.revenueRecognitionSnapshot;
    const [existing] = await tx
      .select({ id: SNAP.id })
      .from(SNAP)
      .where(eq(SNAP.snapshotMonth, month))
      .limit(1);
    if (existing) return { computed: false, month };
    const service = new RevenueRecognitionService(createDrizzleRevenueStore(tx));
    const { snapshot, outbox } = await service.computeAndStoreMonthlySnapshot({
      snapshotMonth: month,
      now,
    });
    await publishIntents(deps.outbox, tx, outbox, null, snapshot.id);
    return { computed: true, month };
  });
}

// ── invoice reconciler ──────────────────────────────────────────────────────────────────────────────────

export interface InvoiceMismatch {
  readonly invoiceId: string;
  readonly stripeInvoiceId: string;
}

/**
 * §2.3 reconciler: for every OPEN/PAID invoice with lines, `SUM(non-tax lines) = subtotal` and `SUM(tax) = tax`.
 * Returns the mismatches (and logs them) - it does not edit money. Comparison against Stripe's own copy of the
 * invoice needs a Stripe read and is NOT done here.
 */
export async function runInvoiceReconcileForOrg(
  deps: M35JobDeps,
  organizationId: string,
): Promise<readonly InvoiceMismatch[]> {
  return withOrgContext(deps.db, { organizationId, userId: "" }, async (scoped) => {
    const tx = scoped as unknown as Tx;
    const INV = schema.invoice;
    const IL = schema.invoiceLine;
    const invoices = await tx
      .select()
      .from(INV)
      .where(and(eq(INV.organizationId, organizationId), inArray(INV.status, ["open", "paid"])));
    const mismatches: InvoiceMismatch[] = [];
    for (const inv of invoices) {
      const lines = await tx.select().from(IL).where(eq(IL.invoiceId, inv.id));
      if (lines.length === 0) continue;
      const ok = invoiceLineSumsConsistent({
        lines: lines.map((l) => ({ kind: l.kind as InvoiceLineKind, totalCents: l.totalCents })),
        subtotalCents: inv.subtotalCents,
        taxCents: inv.taxCents,
      });
      if (!ok) mismatches.push({ invoiceId: inv.id, stripeInvoiceId: inv.stripeInvoiceId });
    }
    if (mismatches.length > 0) {
      deps.log?.("m35 invoice reconciler found line-sum mismatches", {
        organizationId,
        count: mismatches.length,
        invoiceIds: mismatches.map((m) => m.invoiceId),
      });
    }
    return mismatches;
  });
}
