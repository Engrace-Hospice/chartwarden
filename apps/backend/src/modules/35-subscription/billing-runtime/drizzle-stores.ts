// apps/backend/src/modules/35-subscription/billing-runtime/drizzle-stores.ts - GAP-059.
//
// Drizzle implementations of the `@chartwarden/subscription-billing` store PORTS, each bound to ONE open
// transaction (the caller owns `withOrgContext` / the platform runner, the §2.5 row locks and the outbox
// publication). The workers drive the package's pure services (DunningStateMachineService,
// SubscriptionLifecycleService, InvoiceMirrorService, RevenueRecognitionService) over these.
import { type DbClient, schema } from "@chartwarden/db";
import { contributesToMrr, normalizeMonthlyCents } from "@chartwarden/subscription-billing";
import type {
  DunningStateRecord,
  DunningStore,
  InvoiceMirrorRecord,
  InvoiceStore,
  PlanEligibilityFacts,
  RevenueContribution,
  RevenueSnapshotRecord,
  RevenueStore,
  SubscriptionRecord,
  SubscriptionStore,
} from "@chartwarden/subscription-billing";
import type {
  BillingCadence,
  BillingYearMonth,
  DunningStage,
  InvoiceStatus,
  OrgId,
  PlanId,
  PlanTier,
  SubscriptionId,
  SubscriptionStatus,
} from "@chartwarden/types";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

/** An open transaction handle (org-scoped or platform) the stores run their statements on. */
export type StoreTx = DbClient;

const S = schema.subscriptionRow;
const PL = schema.plan;
const SH = schema.subscriptionStateHistory;
const DUN = schema.dunningStateRow;
const INV = schema.invoice;
const IL = schema.invoiceLine;

type SubJoin = { sub: typeof S.$inferSelect; plan: typeof PL.$inferSelect };

function toSubscriptionRecord({ sub, plan }: SubJoin): SubscriptionRecord {
  return {
    id: sub.id as SubscriptionId,
    organizationId: sub.organizationId as OrgId,
    planId: sub.planId as PlanId,
    planSlug: plan.slug,
    planTier: plan.tier as PlanTier,
    status: sub.status as SubscriptionStatus,
    cadence: plan.cadence as BillingCadence,
    basePriceCents: plan.basePriceCents,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
  };
}

function toPlanFacts(plan: typeof PL.$inferSelect): PlanEligibilityFacts {
  return {
    planId: plan.id as PlanId,
    slug: plan.slug,
    tier: plan.tier as PlanTier,
    cadence: plan.cadence as BillingCadence,
    basePriceCents: plan.basePriceCents,
    trialPeriodDays: plan.trialPeriodDays,
    isActive: plan.isActive,
    isDeprecated: plan.deprecatedAt !== null,
  };
}

export function createDrizzleSubscriptionStore(tx: StoreTx): SubscriptionStore {
  return {
    async loadForUpdate(subscriptionId) {
      const [row] = await tx
        .select({ sub: S, plan: PL })
        .from(S)
        .innerJoin(PL, eq(PL.id, S.planId))
        .where(eq(S.id, subscriptionId))
        .limit(1)
        .for("update", { of: S });
      return row ? toSubscriptionRecord(row) : null;
    },
    async activeForOrg(organizationId) {
      const [row] = await tx
        .select({ sub: S, plan: PL })
        .from(S)
        .innerJoin(PL, eq(PL.id, S.planId))
        .where(
          and(
            eq(S.organizationId, organizationId),
            inArray(S.status, ["trialing", "active", "past_due", "at_risk", "suspended"]),
          ),
        )
        .limit(1);
      return row ? toSubscriptionRecord(row) : null;
    },
    async planEligibility(planId) {
      const [plan] = await tx.select().from(PL).where(eq(PL.id, planId)).limit(1);
      return plan ? toPlanFacts(plan) : null;
    },
    async insertSubscription({ organizationId, plan, status }) {
      const [sub] = await tx
        .insert(S)
        .values({ organizationId, planId: plan.planId, status })
        .returning();
      const [planRow] = await tx.select().from(PL).where(eq(PL.id, plan.planId)).limit(1);
      if (!sub || !planRow) throw new Error("subscription insert returned no row");
      return toSubscriptionRecord({ sub, plan: planRow });
    },
    async updateStatus({ subscriptionId, toStatus, cancelAtPeriodEnd }) {
      const at = new Date();
      await tx
        .update(S)
        .set({
          status: toStatus,
          updatedAt: at,
          ...(cancelAtPeriodEnd === undefined ? {} : { cancelAtPeriodEnd }),
          ...(toStatus === "canceled" ? { canceledAt: at } : {}),
          ...(toStatus === "paused" ? { pausedAt: at } : {}),
        })
        .where(eq(S.id, subscriptionId));
    },
    async updatePlan({ subscriptionId, plan }) {
      await tx
        .update(S)
        .set({ planId: plan.planId, updatedAt: new Date() })
        .where(eq(S.id, subscriptionId));
    },
    async appendStateHistory(row) {
      await tx.insert(SH).values({
        subscriptionId: row.subscriptionId,
        organizationId: row.organizationId,
        fromStatus: row.fromStatus,
        toStatus: row.toStatus,
        transitionedAt: row.transitionedAt,
        actorMembershipId: row.actorMembershipId,
        reasonCode: row.reasonCode,
        stripeEventId: row.stripeEventId,
      });
    },
  };
}

function toDunningRecord(row: typeof DUN.$inferSelect): DunningStateRecord {
  return {
    id: row.id,
    organizationId: row.organizationId as OrgId,
    subscriptionId: row.subscriptionId as SubscriptionId,
    stage: row.stage as DunningStage,
    attemptCount: row.attemptCount,
    enteredAt: row.enteredAt,
    triggerInvoiceId: row.triggerInvoiceId,
  };
}

export function createDrizzleDunningStore(tx: StoreTx): DunningStore {
  return {
    async openForSubscription(subscriptionId) {
      const [row] = await tx
        .select()
        .from(DUN)
        .where(and(eq(DUN.subscriptionId, subscriptionId), isNull(DUN.exitedAt)))
        .limit(1)
        .for("update");
      return row ? toDunningRecord(row) : null;
    },
    async enterStage(input) {
      if (input.fromRowId) {
        await tx
          .update(DUN)
          .set({ exitedAt: input.enteredAt, exitReason: input.exitReason ?? "advanced" })
          .where(eq(DUN.id, input.fromRowId));
      }
      const [row] = await tx
        .insert(DUN)
        .values({
          organizationId: input.organizationId,
          subscriptionId: input.subscriptionId,
          stage: input.toStage,
          enteredAt: input.enteredAt,
          nextAttemptAt: input.nextAttemptAt,
          attemptCount: input.attemptCount,
          triggerInvoiceId: input.triggerInvoiceId,
          lastAttemptFailureCode: input.lastAttemptFailureCode,
        })
        .returning();
      if (!row) throw new Error("dunning_state insert returned no row");
      if (input.fromRowId === null) {
        await tx
          .update(S)
          .set({ dunningStartedAt: input.enteredAt })
          .where(eq(S.id, input.subscriptionId));
      }
      return toDunningRecord(row);
    },
    async closeOpen({ rowId, exitedAt, exitReason }) {
      await tx.update(DUN).set({ exitedAt, exitReason }).where(eq(DUN.id, rowId));
    },
  };
}

function toInvoiceRecord(row: typeof INV.$inferSelect): InvoiceMirrorRecord {
  return {
    id: row.id,
    organizationId: row.organizationId as OrgId,
    stripeInvoiceId: row.stripeInvoiceId,
    status: row.status as InvoiceStatus,
    subtotalCents: row.subtotalCents,
    taxCents: row.taxCents,
    totalCents: row.totalCents,
    amountPaidCents: row.amountPaidCents,
  };
}

export function createDrizzleInvoiceStore(tx: StoreTx): InvoiceStore {
  return {
    async invoiceByStripeId(stripeInvoiceId) {
      const [row] = await tx
        .select()
        .from(INV)
        .where(eq(INV.stripeInvoiceId, stripeInvoiceId))
        .limit(1);
      return row ? toInvoiceRecord(row) : null;
    },
    async upsertInvoice(input) {
      const values = {
        organizationId: input.organizationId,
        stripeInvoiceId: input.stripeInvoiceId,
        status: input.status,
        subtotalCents: input.subtotalCents,
        taxCents: input.taxCents,
        totalCents: input.totalCents,
        amountPaidCents: input.amountPaidCents,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        paidAt: input.paidAt,
        lastSyncedAt: new Date(),
      };
      const [row] = await tx
        .insert(INV)
        .values(values)
        .onConflictDoUpdate({ target: INV.stripeInvoiceId, set: values })
        .returning();
      if (!row) throw new Error("invoice upsert returned no row");
      return toInvoiceRecord(row);
    },
    async replaceInvoiceLines({ invoiceId, lines }) {
      const [inv] = await tx.select().from(INV).where(eq(INV.id, invoiceId)).limit(1);
      if (!inv) throw new Error(`invoice ${invoiceId} not found`);
      await tx.delete(IL).where(eq(IL.invoiceId, invoiceId));
      if (lines.length === 0) return;
      await tx.insert(IL).values(
        lines.map((l) => ({
          organizationId: inv.organizationId,
          invoiceId,
          stripeLineId: l.stripeLineId,
          kind: l.kind,
          description: l.description,
          quantity: l.quantity,
          unitAmountCents: l.unitAmountCents,
          totalCents: l.totalCents,
        })),
      );
    },
  };
}

/** Platform-wide revenue reads/writes; MUST run on the platform runner (cross-tenant + platform-only table). */
export function createDrizzleRevenueStore(tx: StoreTx): RevenueStore {
  const SNAP = schema.revenueRecognitionSnapshot;
  return {
    async currentContributions(): Promise<RevenueContribution[]> {
      const rows = await tx
        .select({ id: S.id, status: S.status, cadence: PL.cadence, price: PL.basePriceCents })
        .from(S)
        .innerJoin(PL, eq(PL.id, S.planId));
      return rows.map((r) => ({
        subscriptionId: r.id as SubscriptionId,
        status: r.status as SubscriptionStatus,
        monthlyCents: normalizeMonthlyCents(r.cadence as BillingCadence, r.price),
      }));
    },
    async priorMonthContributions(priorYearMonth: BillingYearMonth) {
      // Each subscription's status as of the END of the prior month, from its append-only state history
      // (latest transition before the first instant of the following month), priced at its CURRENT plan -
      // plan history is not retained, so a mid-month plan change shows as movement in the month it is seen.
      const [y, m] = priorYearMonth.split("-").map(Number);
      const monthEnd = new Date(Date.UTC(y ?? 1970, m ?? 1, 1));
      const rows = await tx.execute<{
        subscription_id: string;
        to_status: SubscriptionStatus;
        cadence: BillingCadence;
        base_price_cents: string | number;
      }>(sql`
        SELECT DISTINCT ON (h.subscription_id)
               h.subscription_id, h.to_status, pl.cadence, pl.base_price_cents
          FROM subscription_state_history h
          JOIN subscription s ON s.id = h.subscription_id
          JOIN plan pl ON pl.id = s.plan_id
         WHERE h.transitioned_at < ${monthEnd.toISOString()}::timestamptz
         ORDER BY h.subscription_id, h.transitioned_at DESC
      `);
      const out = new Map<SubscriptionId, number>();
      for (const r of rows.rows) {
        if (!contributesToMrr(r.to_status)) continue;
        out.set(
          r.subscription_id as SubscriptionId,
          normalizeMonthlyCents(r.cadence, Number(r.base_price_cents)),
        );
      }
      return out;
    },
    async insertSnapshot(input): Promise<RevenueSnapshotRecord> {
      const [row] = await tx
        .insert(SNAP)
        .values({
          snapshotMonth: input.snapshotMonth,
          mrrCents: input.mrrCents,
          arrCents: input.arrCents,
          newMrrCents: input.newMrrCents,
          expansionMrrCents: input.expansionMrrCents,
          contractionMrrCents: input.contractionMrrCents,
          churnMrrCents: input.churnMrrCents,
          activeSubscriptions: input.activeSubscriptions,
          trialingSubscriptions: input.trialingSubscriptions,
          pastDueSubscriptions: input.pastDueSubscriptions,
          computedAt: input.computedAt,
        })
        .returning();
      if (!row) throw new Error("revenue snapshot insert returned no row");
      return {
        id: row.id,
        snapshotMonth: row.snapshotMonth as BillingYearMonth,
        mrrCents: row.mrrCents,
        arrCents: row.arrCents,
        activeSubscriptions: row.activeSubscriptions,
        computedAt: row.computedAt,
      };
    },
  };
}
