// @chartwarden/subscription-billing — §D18 MRR/ARR monthly snapshot service (pure over ports, M35-T03).
//
// The monthly `revenue_recognition_snapshot` computation. MRR is the sum of each subscription's monthly-
// normalized base price while it is in a REVENUE-RECOGNIZED status (`active` / `past_due` / `at_risk` —
// the subscription is still billing); `trialing`, `paused`, `suspended`, and `canceled` contribute $0.
// ARR = MRR × 12. The new/expansion/contraction/churn breakdown diffs the current per-subscription MRR
// contribution against the prior month's — the standard SaaS MRR-movement decomposition:
//
//   new         = subs present this month, absent last month           → +contribution
//   expansion   = subs in both, contribution went UP                   → +Δ
//   contraction = subs in both, contribution went DOWN (but > 0)       → −Δ (stored positive)
//   churn       = subs present last month, gone/zero this month        → −prior (stored positive)
//
// PURE: `computeRevenueSnapshot` is a deterministic function of (contributions, prior map); the service
// wraps it with the store read/write + the `m35.revenue.monthly_snapshot_computed` outbox. Integer cents
// throughout (§2.3 — no float).

import type {
  BillingCadence,
  BillingYearMonth,
  IsoInstant,
  SubscriptionStatus,
} from "@chartwarden/types";
import {
  type OutboxIntent,
  type RevenueContribution,
  type RevenueSnapshotRecord,
  type RevenueStore,
  outboxIntent,
} from "./ports";

/** The statuses whose subscription contributes to recognized MRR (still billing). */
export const MRR_RECOGNIZED_STATUSES: readonly SubscriptionStatus[] = [
  "active",
  "past_due",
  "at_risk",
];

/** §D18 normalize a subscription's base price to a MONTHLY figure (annual → base / 12, rounded). */
export function normalizeMonthlyCents(cadence: BillingCadence, basePriceCents: number): number {
  const base = Math.max(0, Math.trunc(basePriceCents));
  return cadence === "annual" ? Math.round(base / 12) : base;
}

/** True iff a subscription in `status` contributes to recognized MRR. */
export function contributesToMrr(status: SubscriptionStatus): boolean {
  return MRR_RECOGNIZED_STATUSES.includes(status);
}

export interface RevenueSnapshotComputation {
  readonly snapshotMonth: BillingYearMonth;
  readonly mrrCents: number;
  readonly arrCents: number;
  readonly newMrrCents: number;
  readonly expansionMrrCents: number;
  readonly contractionMrrCents: number;
  readonly churnMrrCents: number;
  readonly activeSubscriptions: number;
  readonly trialingSubscriptions: number;
  readonly pastDueSubscriptions: number;
}

/**
 * §D18 the pure snapshot computation. `contributions` is every subscription's current monthly cents +
 * status; `priorContributions` maps `subscriptionId → monthlyCents` for the prior month (empty for the
 * first snapshot — everything is `new`). Only recognized-status subscriptions carry a non-zero
 * contribution into the MRR total and the movement math.
 */
export function computeRevenueSnapshot(input: {
  snapshotMonth: BillingYearMonth;
  contributions: readonly RevenueContribution[];
  priorContributions: ReadonlyMap<string, number>;
}): RevenueSnapshotComputation {
  let mrrCents = 0;
  let newMrrCents = 0;
  let expansionMrrCents = 0;
  let contractionMrrCents = 0;
  let activeSubscriptions = 0;
  let trialingSubscriptions = 0;
  let pastDueSubscriptions = 0;

  const currentById = new Map<string, number>();

  for (const c of input.contributions) {
    if (c.status === "active") activeSubscriptions += 1;
    else if (c.status === "trialing") trialingSubscriptions += 1;
    else if (c.status === "past_due") pastDueSubscriptions += 1;

    const current = contributesToMrr(c.status) ? Math.max(0, Math.trunc(c.monthlyCents)) : 0;
    currentById.set(c.subscriptionId, current);
    mrrCents += current;

    const prior = input.priorContributions.get(c.subscriptionId) ?? 0;
    if (prior === 0 && current > 0) {
      newMrrCents += current;
    } else if (current > prior) {
      expansionMrrCents += current - prior;
    } else if (current < prior) {
      contractionMrrCents += prior - current;
    }
  }

  // Churn: subscriptions that contributed last month and are absent/zero this month.
  let churnMrrCents = 0;
  for (const [subId, prior] of input.priorContributions) {
    if (prior <= 0) continue;
    const current = currentById.get(subId) ?? 0;
    if (current === 0) churnMrrCents += prior;
  }

  return {
    snapshotMonth: input.snapshotMonth,
    mrrCents,
    arrCents: mrrCents * 12,
    newMrrCents,
    expansionMrrCents,
    contractionMrrCents,
    churnMrrCents,
    activeSubscriptions,
    trialingSubscriptions,
    pastDueSubscriptions,
  };
}

/** The prior calendar month (`YYYY-MM`) of a `YYYY-MM` key (used to fetch last month's contributions). */
export function priorBillingYearMonth(yearMonth: BillingYearMonth): BillingYearMonth {
  const [yStr, mStr] = yearMonth.split("-");
  const y = Number(yStr);
  const m = Number(mStr);
  const priorMonth = m === 1 ? 12 : m - 1;
  const priorYear = m === 1 ? y - 1 : y;
  return `${priorYear.toString().padStart(4, "0")}-${priorMonth.toString().padStart(2, "0")}`;
}

export class RevenueRecognitionService {
  constructor(private readonly store: RevenueStore) {}

  /** §D18 compute + persist the month-end snapshot, returning the row + the platform-wide outbox emit. */
  async computeAndStoreMonthlySnapshot(input: {
    snapshotMonth: BillingYearMonth;
    now: Date;
  }): Promise<{ snapshot: RevenueSnapshotRecord; outbox: OutboxIntent[] }> {
    const contributions = await this.store.currentContributions();
    const priorContributions = await this.store.priorMonthContributions(
      priorBillingYearMonth(input.snapshotMonth),
    );
    const computed = computeRevenueSnapshot({
      snapshotMonth: input.snapshotMonth,
      contributions,
      priorContributions,
    });

    const snapshot = await this.store.insertSnapshot({ ...computed, computedAt: input.now });

    return {
      snapshot,
      outbox: [
        outboxIntent("m35.revenue.monthly_snapshot_computed", {
          snapshotId: snapshot.id,
          snapshotMonth: snapshot.snapshotMonth,
          mrrCents: snapshot.mrrCents,
          arrCents: snapshot.arrCents,
          activeSubscriptions: snapshot.activeSubscriptions,
        }),
      ],
    };
  }
}

/** Convenience: convert a computation into the leaf snapshot DTO shape (T05 seam + T06 route read). */
export function toSnapshotDto(record: RevenueSnapshotRecord): {
  id: string;
  snapshotMonth: BillingYearMonth;
  mrrCents: number;
  arrCents: number;
  activeSubscriptions: number;
  computedAt: IsoInstant;
} {
  return {
    id: record.id,
    snapshotMonth: record.snapshotMonth,
    mrrCents: record.mrrCents,
    arrCents: record.arrCents,
    activeSubscriptions: record.activeSubscriptions,
    computedAt: record.computedAt.toISOString() as IsoInstant,
  };
}
