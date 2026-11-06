// apps/backend/src/modules/35-subscription/pricing/statement-plan.ts — WHAT a statement run computes, as pure functions (slice 2).
//
// Given the facts of one contract (read by statement-inputs.ts) and the meters of a month, these decide: which months need a statement
// (`planMonths`), which late-posted money rides the next open statement (`priorPeriodLinesFor`), and the figures of a statement row
// (`buildStatementValues`). No IO and no clock, so every money rule is a plain unit test; the service only orchestrates reads and writes.
//
//   MONTHS     every calendar month from the go-live month to the current one, minus months already final. A month the subscription was
//              live in (days live > 0) is a regular statement; the CURRENT month with no live days (the subscription ended or is paused)
//              is only a candidate SETTLEMENT statement, written solely when it has prior-period lines to carry.
//   PRIOR-PERIOD MONEY (D4)  statements finalize at month end + the grace. An 835 dated inside a closed month that posts after that is
//              never lost and never re-bills the closed month: its net collections are the month's NOW-collections, less what its final
//              statement billed, less what an earlier prior-period line already carried. That delta, at the SOURCE month's own rate, is a
//              line on the next open statement, stored with its source month. A delta that is negative is not a credit; one too small to
//              round to a cent waits and accumulates.
import type { schema } from "@chartwarden/db";
import {
  type PlanPricing,
  averageDailyCensusHundredths,
  billingFeeCents,
  computeStatementAmounts,
  lateCollectionsCents,
} from "@chartwarden/subscription-billing";
import type { BillingServiceMode, NetCollections } from "@chartwarden/types";
import { ChartWardenError } from "@chartwarden/types";
import { type ModeHistoryRow, modeInForceOn } from "./contract-mode";
import type { StaffCount } from "./staff-meter";
import {
  type LiveWindow,
  type MonthPeriod,
  calendarMonthOf,
  daysLiveInMonth,
  isFinalizable,
  monthsFromThrough,
} from "./statement-period";

type PriorPeriodLine = schema.PriorPeriodLine;

/** The part of a stored statement the planner reads. */
export interface ExistingStatement {
  readonly id: string;
  readonly periodYearMonth: string;
  readonly status: "draft" | "final";
  readonly netCollectionsCents: number;
  readonly netCollectionsRemittanceCount: number;
  readonly billingServiceMode: BillingServiceMode;
  readonly billingBps: number;
  readonly priorPeriodLines: readonly PriorPeriodLine[];
  /** `figuresOf` of the stored row: a rerun whose figures equal it writes nothing. */
  readonly figures: string;
}

export interface ContractFacts {
  readonly organizationId: string;
  readonly subscriptionId: string;
  readonly contractId: string;
  readonly planId: string;
  readonly currencyCode: string;
  readonly implementationFeeCents: number;
  readonly pricing: PlanPricing;
  readonly modeHistory: readonly ModeHistoryRow[];
  /** When the tenant went live (or the subscription started, if later). */
  readonly liveFrom: Date;
  readonly windows: readonly LiveWindow[];
  readonly statements: readonly ExistingStatement[];
}

export interface MonthWork {
  readonly period: MonthPeriod;
  readonly daysLive: number;
  readonly mode: BillingServiceMode;
  readonly finalize: boolean;
  /** No live days: only written when it has prior-period lines to carry. */
  readonly settlement: boolean;
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** The months of this contract that still need a statement as of `at`, oldest first. */
export function planMonths(facts: ContractFacts, at: Date): MonthWork[] {
  const current = calendarMonthOf(at);
  const final = new Set(
    facts.statements.filter((s) => s.status === "final").map((s) => s.periodYearMonth),
  );
  const work: MonthWork[] = [];
  for (const period of monthsFromThrough(facts.liveFrom, at)) {
    if (final.has(period.key)) continue;
    const daysLive = daysLiveInMonth(period, facts.windows);
    if (daysLive === 0 && period.key !== current.key) continue;
    // The mode in force on the first day this month bills: a change recorded mid-month waits for the 1st of the next.
    const anchor = period.start > facts.liveFrom ? period.start : facts.liveFrom;
    const mode = modeInForceOn(facts.modeHistory, isoDate(anchor));
    if (mode === null) {
      throw new ChartWardenError(
        "CONTRACT_MODE_MISSING",
        "the contract has no billing service mode in force; refusing to compute a statement from it",
        500,
      );
    }
    work.push({
      period,
      daysLive,
      mode,
      finalize: isFinalizable(period, at),
      settlement: daysLive === 0,
    });
  }
  return work;
}

const NO_COLLECTIONS: NetCollections = { netCents: 0, remittanceCount: 0, pendingCount: 0 };

/** The prior-period lines for a statement of `target`: every FINAL earlier statement whose month collected more since it closed. */
export function priorPeriodLinesFor(
  target: MonthPeriod,
  statements: readonly ExistingStatement[],
  netByMonth: ReadonlyMap<string, NetCollections>,
): PriorPeriodLine[] {
  const finals = statements.filter((s) => s.status === "final");
  const lines: PriorPeriodLine[] = [];
  for (const source of [...finals].sort((a, b) =>
    a.periodYearMonth.localeCompare(b.periodYearMonth),
  )) {
    if (source.periodYearMonth >= target.key || source.billingBps === 0) continue;
    const carried = finals
      .flatMap((s) => s.priorPeriodLines)
      .filter((l) => l.sourceYearMonth === source.periodYearMonth);
    const carriedNet = carried.reduce((sum, l) => sum + l.netCollectionsCents, 0);
    const carriedCount = carried.reduce((sum, l) => sum + l.remittanceCount, 0);
    const now = netByMonth.get(source.periodYearMonth) ?? NO_COLLECTIONS;
    const netCollectionsCents = lateCollectionsCents(
      now.netCents,
      source.netCollectionsCents,
      carriedNet,
    );
    const feeCents = billingFeeCents(netCollectionsCents, source.billingBps);
    if (feeCents === 0) continue;
    lines.push({
      sourceYearMonth: source.periodYearMonth,
      netCollectionsCents,
      remittanceCount: Math.max(
        0,
        now.remittanceCount - source.netCollectionsRemittanceCount - carriedCount,
      ),
      billingServiceMode: source.billingServiceMode,
      billingBps: source.billingBps,
      feeCents,
    });
  }
  return lines;
}

export interface MonthMeters {
  /** The daily active-patient counts observed in the month (empty = none observed). */
  readonly daily: readonly number[];
  readonly staff: StaffCount;
  readonly collections: NetCollections;
}

const NO_STAFF: StaffCount = { count: 0, basis: "identity_filtered" };

/** A settlement statement reads no meter: the month itself was not live. */
const SETTLEMENT_METERS: MonthMeters = {
  daily: [],
  staff: NO_STAFF,
  collections: NO_COLLECTIONS,
};

interface BuildInput {
  readonly facts: ContractFacts;
  readonly work: MonthWork;
  readonly meters: MonthMeters;
  readonly priorLines: readonly PriorPeriodLine[];
  /** True when no earlier statement of this subscription exists: the implementation fee rides this one. */
  readonly isFirstStatement: boolean;
  readonly at: Date;
}

/** The census mean and the amounts of one month: the pure math, with the proration and the prior-period fee. */
function amountsOf(input: BuildInput, meters: MonthMeters) {
  const { facts, work, priorLines } = input;
  const adc = averageDailyCensusHundredths(meters.daily);
  const amounts = computeStatementAmounts(facts.pricing, {
    staffCount: meters.staff.count,
    adcHundredths: adc.adcHundredths,
    netCollectionsCents: meters.collections.netCents,
    mode: work.mode,
    oneTimeFeeCents: input.isFirstStatement && !work.settlement ? facts.implementationFeeCents : 0,
    proration: { daysLive: work.daysLive, daysInPeriod: work.period.days },
    priorPeriodFeeCents: priorLines.reduce((sum, l) => sum + l.feeCents, 0),
  });
  return { adc, amounts };
}

/** The row to insert (or the figures to replace a draft with) for one month. */
export function buildStatementValues(input: BuildInput) {
  const { facts, work, priorLines, at } = input;
  const meters = work.settlement ? SETTLEMENT_METERS : input.meters;
  const { adc, amounts } = amountsOf(input, meters);
  return {
    organizationId: facts.organizationId,
    subscriptionId: facts.subscriptionId,
    planId: facts.planId,
    periodYearMonth: work.period.key,
    periodStart: work.period.start,
    periodEnd: work.period.end,
    status: work.finalize ? ("final" as const) : ("draft" as const),
    staffCount: meters.staff.count,
    staffCountBasis: meters.staff.basis,
    adcHundredths: adc.adcHundredths,
    adcDaysObserved: adc.days,
    adcDaysInPeriod: work.period.days,
    daysLive: work.daysLive,
    billingServiceMode: work.mode,
    netCollectionsCents: meters.collections.netCents,
    netCollectionsRemittanceCount: meters.collections.remittanceCount,
    netCollectionsPendingCount: meters.collections.pendingCount,
    perUserPriceCents: facts.pricing.perUserPriceCents,
    bandMinAdc: amounts.bandMinAdc,
    bandFeeCents: amounts.bandFeeCents,
    billingBps: amounts.billingBps,
    minimumMonthlyCents: facts.pricing.minimumMonthlyCents,
    perUserSubtotalCents: amounts.perUserSubtotalCents,
    platformFeeCents: amounts.platformFeeCents,
    platformFeeBasis: amounts.platformFeeBasis,
    billingFeeCents: amounts.billingFeeCents,
    oneTimeFeeCents: amounts.oneTimeFeeCents,
    minimumAdjustmentCents: amounts.minimumAdjustmentCents,
    priorPeriodLines: priorLines,
    priorPeriodFeeCents: amounts.priorPeriodFeeCents,
    totalCents: amounts.totalCents,
    // The staff count fell back to the unfiltered ledger, or a remittance of the month had not posted when it closed.
    needsReview:
      meters.staff.basis === "ledger_unfiltered" ||
      (work.finalize && meters.collections.pendingCount > 0),
    computedAt: at,
    finalizedAt: work.finalize ? at : null,
  };
}

export type StatementValues = ReturnType<typeof buildStatementValues>;

/** The figures that make two statements the same statement: everything but identity and timestamps (a rerun that changes none writes nothing). */
const FIGURE_KEYS = [
  "planId",
  "periodYearMonth",
  "periodStart",
  "periodEnd",
  "status",
  "staffCount",
  "staffCountBasis",
  "adcHundredths",
  "adcDaysObserved",
  "adcDaysInPeriod",
  "daysLive",
  "billingServiceMode",
  "netCollectionsCents",
  "netCollectionsRemittanceCount",
  "netCollectionsPendingCount",
  "perUserPriceCents",
  "bandMinAdc",
  "bandFeeCents",
  "billingBps",
  "minimumMonthlyCents",
  "perUserSubtotalCents",
  "platformFeeCents",
  "platformFeeBasis",
  "billingFeeCents",
  "oneTimeFeeCents",
  "minimumAdjustmentCents",
  "priorPeriodLines",
  "priorPeriodFeeCents",
  "totalCents",
  "needsReview",
] as const satisfies readonly (keyof StatementValues)[];

export function figuresOf(row: Pick<StatementValues, (typeof FIGURE_KEYS)[number]>): string {
  return JSON.stringify(
    FIGURE_KEYS.map((key) =>
      // jsonb hands its keys back in its own order, so a line is compared as a fixed-order tuple, never as the object
      key === "priorPeriodLines"
        ? row.priorPeriodLines.map((l) => [
            l.sourceYearMonth,
            l.netCollectionsCents,
            l.remittanceCount,
            l.billingServiceMode,
            l.billingBps,
            l.feeCents,
          ])
        : row[key],
    ),
  );
}
