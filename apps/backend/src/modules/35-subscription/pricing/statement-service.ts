// apps/backend/src/modules/35-subscription/pricing/statement-service.ts — the MONTHLY STATEMENT computation (slice 2, tenant pricing).
//
// One statement per subscription per UTC calendar month, computed from three meters and the plan VERSION the tenant signed:
//   staff     active staff accounts          ./staff-meter.ts   (the user_active_period ledger + the identity roles)
//   ADC       average daily census           ./census-daily.ts  (M5 PatientCensusReader, via the m35.patient-census sweep)
//   net coll. net collections of the month   the `NetCollectionsReader` seam (M25 remittance: see its header for the exact definition)
// and the pure math in @chartwarden/subscription-billing (greater-of platform fee, billing fee, one-time fee, minimum).
//
// LIFECYCLE (the census shape: a window is final once it is closed). The month in progress is a `draft`, recomputed on every sweep
// (idempotent: the row is unique on (subscription, month) and an upsert replaces a draft). A month is finalized by the first sweep at or
// after its end plus STATEMENT_FINALIZE_GRACE_DAYS: money is dated by its EFT effective date (BPR16), and an 835 dated the 31st routinely
// arrives on the 2nd, so a statement finalized at midnight would under-bill the month. A final row is never recomputed (and a trigger
// freezes it). A month with no observed census day is not billed at all: the organisation was not live and swept in it (the sweep
// fans out over ACTIVE organisations only), so an onboarding tenant pays nothing until go-live.
//
// The ONE-TIME implementation fee rides the first statement of the contract. Writes run on the platform runner only; a tenant
// holds SELECT. Stripe: the statement is computed and stored, and `StatementStripePort` is the clearly marked seam for pushing a
// FINAL statement as metered usage. It is unbound: M35 has no Stripe subscription or meter wiring yet (ADR-0108 D7).
import { schema } from "@chartwarden/db";
import {
  type CensusBand,
  type PseudonymKeyProvider,
  type StatementAmounts,
  averageDailyCensusHundredths,
  computeStatementAmounts,
  toBillingYearMonth,
} from "@chartwarden/subscription-billing";
import type { BillingServiceMode, NetCollectionsReader, OrgId } from "@chartwarden/types";
import { ChartWardenError } from "@chartwarden/types";
import { and, asc, eq, lt } from "drizzle-orm";
import type { PlatformRunner, WriteTx } from "../routes/service-drizzle";
import { readDailyCensus } from "./census-daily";
import { type MonthWindow, countActiveStaffForMonth } from "./staff-meter";

const SS = schema.subscriptionStatement;
const SC = schema.subscriptionContract;
const SUB = schema.subscriptionRow;
const PL = schema.plan;
const PCB = schema.planCensusBand;

/** How long after a month ends its statement stays a draft: late-posted remittances dated inside the month still count. */
export const STATEMENT_FINALIZE_GRACE_DAYS = 5;
const DAY_MS = 86_400_000;
/** Subscription statuses that are not billed: a canceled or paused subscription owes nothing for the month. */
const UNBILLED_STATUSES: ReadonlySet<string> = new Set(["canceled", "paused"]);

export interface MonthPeriod extends MonthWindow {
  readonly key: string;
  readonly days: number;
}

/** The UTC calendar month containing `at`. */
export function calendarMonthOf(at: Date): MonthPeriod {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return {
    start,
    end,
    key: toBillingYearMonth(start),
    days: Math.round((end.getTime() - start.getTime()) / DAY_MS),
  };
}

export const previousCalendarMonth = (period: MonthPeriod): MonthPeriod =>
  calendarMonthOf(new Date(period.start.getTime() - 1));

/** True once a month may be finalized: its end plus the grace has passed. */
export const isFinalizable = (period: MonthPeriod, at: Date): boolean =>
  at.getTime() >= period.end.getTime() + STATEMENT_FINALIZE_GRACE_DAYS * DAY_MS;

export interface StatementView {
  readonly id: string;
  readonly periodYearMonth: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: "draft" | "final";
  readonly currencyCode: string;
  readonly inputs: {
    readonly staffCount: number;
    readonly staffCountBasis: "identity_filtered" | "ledger_unfiltered";
    readonly averageDailyCensus: number;
    readonly adcDaysObserved: number;
    readonly adcDaysInPeriod: number;
    readonly billingServiceMode: BillingServiceMode;
    readonly netCollectionsCents: number;
    readonly netCollectionsRemittanceCount: number;
    readonly netCollectionsPendingCount: number;
  };
  readonly terms: {
    readonly perUserPriceCents: number;
    readonly bandMinAdc: number;
    readonly bandFeeCents: number;
    readonly billingBps: number;
    readonly minimumMonthlyCents: number | null;
  };
  readonly platformFee: {
    readonly perUserSubtotalCents: number;
    readonly bandFeeCents: number;
    readonly feeCents: number;
    readonly basis: "per_user" | "census_band";
  };
  readonly billingFeeCents: number;
  readonly oneTimeFeeCents: number;
  readonly minimumAdjustmentCents: number;
  readonly totalCents: number;
  readonly computedAt: string;
  readonly finalizedAt: string | null;
}

type StatementRow = typeof SS.$inferSelect;

export function toStatementView(row: StatementRow, currencyCode: string): StatementView {
  return {
    id: row.id,
    periodYearMonth: row.periodYearMonth,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    status: row.status,
    currencyCode,
    inputs: {
      staffCount: row.staffCount,
      staffCountBasis: row.staffCountBasis,
      averageDailyCensus: row.adcHundredths / 100,
      adcDaysObserved: row.adcDaysObserved,
      adcDaysInPeriod: row.adcDaysInPeriod,
      billingServiceMode: row.billingServiceMode,
      netCollectionsCents: row.netCollectionsCents,
      netCollectionsRemittanceCount: row.netCollectionsRemittanceCount,
      netCollectionsPendingCount: row.netCollectionsPendingCount,
    },
    terms: {
      perUserPriceCents: row.perUserPriceCents,
      bandMinAdc: row.bandMinAdc,
      bandFeeCents: row.bandFeeCents,
      billingBps: row.billingBps,
      minimumMonthlyCents: row.minimumMonthlyCents,
    },
    platformFee: {
      perUserSubtotalCents: row.perUserSubtotalCents,
      bandFeeCents: row.bandFeeCents,
      feeCents: row.platformFeeCents,
      basis: row.platformFeeBasis,
    },
    billingFeeCents: row.billingFeeCents,
    oneTimeFeeCents: row.oneTimeFeeCents,
    minimumAdjustmentCents: row.minimumAdjustmentCents,
    totalCents: row.totalCents,
    computedAt: row.computedAt.toISOString(),
    finalizedAt: row.finalizedAt?.toISOString() ?? null,
  };
}

/**
 * THE STRIPE SEAM. Pushing a FINAL statement to Stripe as metered usage is not built: M35 has no Stripe subscription or meter wiring
 * (`subscription.stripe_subscription_id` is never written; the HTTP transport has no subscription operations). When it exists, bind a
 * port here: it receives the final statement (id = the idempotency key, `totalCents` and its lines = the amounts to report) and
 * returns the Stripe usage record id, which is stored in `stripe_usage_record_id` / `stripe_posted_at`. Until then a final statement
 * is computed, stored and readable, and the two columns stay null (the `subscription_statement_unposted_ix` index lists what waits).
 */
export interface StatementStripePort {
  pushFinalStatement(statement: StatementView): Promise<{ readonly usageRecordId: string }>;
}

export interface StatementDeps {
  readonly platformRunner: PlatformRunner;
  readonly keyProvider: PseudonymKeyProvider;
  readonly netCollections: NetCollectionsReader;
  readonly stripe?: StatementStripePort;
  readonly now?: () => Date;
  readonly log?: (message: string, detail: Record<string, unknown>) => void;
}

export type StatementOutcome =
  | { readonly outcome: "written"; readonly statement: StatementView }
  | {
      readonly outcome: "skipped";
      readonly periodYearMonth: string;
      readonly reason: "final" | "no_census";
    };

interface Loaded {
  readonly subscriptionId: string;
  readonly planId: string;
  readonly mode: BillingServiceMode;
  readonly implementationFeeCents: number;
  readonly currencyCode: string;
  readonly pricing: {
    readonly perUserPriceCents: number;
    readonly bands: readonly CensusBand[];
    readonly billingSoftwareBps: number;
    readonly managedBillingBps: number;
    readonly minimumMonthlyCents: number | null;
  };
}

/** The org's contract with the plan version it signed and that plan's bands; null when it has none or is not billed. */
async function loadContract(tx: WriteTx, organizationId: string): Promise<Loaded | null> {
  const [row] = await tx
    .select({ contract: SC, sub: SUB, plan: PL })
    .from(SC)
    .innerJoin(SUB, eq(SUB.id, SC.subscriptionId))
    .innerJoin(PL, eq(PL.id, SC.planId))
    .where(eq(SC.organizationId, organizationId))
    .limit(1);
  if (!row || UNBILLED_STATUSES.has(row.sub.status)) return null;
  const { plan } = row;
  if (
    plan.perUserPriceCents === null ||
    plan.billingSoftwareBps === null ||
    plan.managedBillingBps === null ||
    plan.implementationFeeCents === null
  ) {
    throw new ChartWardenError(
      "PLAN_PRICING_INCOMPLETE",
      "the contracted plan has no prices; refusing to compute a statement from it",
      500,
    );
  }
  const bands = await tx
    .select({ minAdc: PCB.minAdc, monthlyFeeCents: PCB.monthlyFeeCents })
    .from(PCB)
    .where(eq(PCB.planId, plan.id))
    .orderBy(asc(PCB.minAdc));
  return {
    subscriptionId: row.sub.id,
    planId: plan.id,
    mode: row.contract.billingServiceMode,
    implementationFeeCents: plan.implementationFeeCents,
    currencyCode: plan.currencyCode,
    pricing: {
      perUserPriceCents: plan.perUserPriceCents,
      bands,
      billingSoftwareBps: plan.billingSoftwareBps,
      managedBillingBps: plan.managedBillingBps,
      minimumMonthlyCents: plan.minimumMonthlyCents,
    },
  };
}

interface MonthPlan {
  readonly period: MonthPeriod;
  readonly daily: readonly number[];
  readonly collections: {
    readonly netCents: number;
    readonly remittanceCount: number;
    readonly pendingCount: number;
  };
}

/**
 * One org, both months, as FEW platform transactions as possible (every platform-runner call is an audited bypass entry, and this runs
 * hourly): one read (contract, plan, bands, what exists, the daily census), the M25 meter per month that needs it, one write.
 */
async function statementsForOrg(
  deps: StatementDeps,
  organizationId: string,
  periods: readonly MonthPeriod[],
  at: Date,
): Promise<StatementOutcome[]> {
  const first = await deps.platformRunner(async (tx) => {
    const loaded = await loadContract(tx, organizationId);
    if (!loaded) return null;
    const months = [];
    for (const period of periods) {
      const [existing] = await tx
        .select({ status: SS.status })
        .from(SS)
        .where(
          and(eq(SS.subscriptionId, loaded.subscriptionId), eq(SS.periodYearMonth, period.key)),
        )
        .limit(1);
      months.push({
        period,
        final: existing?.status === "final",
        daily: await readDailyCensus(tx, organizationId, period),
      });
    }
    return { loaded, months };
  });
  if (!first) return [];
  const { loaded } = first;

  const outcomes: StatementOutcome[] = [];
  const todo: MonthPlan[] = [];
  for (const m of first.months) {
    if (m.final)
      outcomes.push({ outcome: "skipped", periodYearMonth: m.period.key, reason: "final" });
    else if (m.daily.length === 0)
      outcomes.push({ outcome: "skipped", periodYearMonth: m.period.key, reason: "no_census" });
    else {
      // The M25 meter, read under the org's RLS before the platform write. A failure throws; it is never recorded as zero collections.
      const collections = await deps.netCollections.netCollectionsForPeriod(
        organizationId as OrgId,
        {
          periodStart: m.period.start,
          periodEnd: m.period.end,
        },
      );
      todo.push({ period: m.period, daily: m.daily, collections });
    }
  }
  if (todo.length === 0) return outcomes;

  const written = await deps.platformRunner(async (tx) => {
    const rows: StatementRow[] = [];
    // Earlier month first: the one-time implementation fee belongs to the first statement the contract ever has.
    for (const plan of todo)
      rows.push(...(await writeStatement(tx, deps, loaded, organizationId, plan, at)));
    return rows;
  });
  for (const row of written) {
    const view = toStatementView(row, loaded.currencyCode);
    if (row.status === "final") await pushToStripe(deps, row.id, view);
    outcomes.push({ outcome: "written", statement: view });
  }
  for (const plan of todo) {
    if (!written.some((r) => r.periodYearMonth === plan.period.key)) {
      outcomes.push({ outcome: "skipped", periodYearMonth: plan.period.key, reason: "final" });
    }
  }
  return outcomes.sort((x, y) => outcomeKey(x).localeCompare(outcomeKey(y)));
}

const outcomeKey = (o: StatementOutcome): string =>
  o.outcome === "written" ? o.statement.periodYearMonth : o.periodYearMonth;

/** Compute and upsert one month inside the caller's platform transaction; [] when the row was already final. */
async function writeStatement(
  tx: WriteTx,
  deps: StatementDeps,
  loaded: Loaded,
  organizationId: string,
  plan: MonthPlan,
  at: Date,
): Promise<StatementRow[]> {
  const { period, collections } = plan;
  const adc = averageDailyCensusHundredths(plan.daily);
  const finalize = isFinalizable(period, at);
  const staff = await countActiveStaffForMonth(tx, deps.keyProvider, organizationId, period);
  const [earlier] = await tx
    .select({ id: SS.id })
    .from(SS)
    .where(and(eq(SS.subscriptionId, loaded.subscriptionId), lt(SS.periodYearMonth, period.key)))
    .limit(1);
  const amounts: StatementAmounts = computeStatementAmounts(loaded.pricing, {
    staffCount: staff.count,
    adcHundredths: adc.adcHundredths,
    netCollectionsCents: collections.netCents,
    mode: loaded.mode,
    oneTimeFeeCents: earlier ? 0 : loaded.implementationFeeCents,
  });
  const values = {
    organizationId,
    subscriptionId: loaded.subscriptionId,
    planId: loaded.planId,
    periodYearMonth: period.key,
    periodStart: period.start,
    periodEnd: period.end,
    status: finalize ? ("final" as const) : ("draft" as const),
    staffCount: staff.count,
    staffCountBasis: staff.basis,
    adcHundredths: adc.adcHundredths,
    adcDaysObserved: adc.days,
    adcDaysInPeriod: period.days,
    billingServiceMode: loaded.mode,
    netCollectionsCents: collections.netCents,
    netCollectionsRemittanceCount: collections.remittanceCount,
    netCollectionsPendingCount: collections.pendingCount,
    perUserPriceCents: loaded.pricing.perUserPriceCents,
    bandMinAdc: amounts.bandMinAdc,
    bandFeeCents: amounts.bandFeeCents,
    billingBps: amounts.billingBps,
    minimumMonthlyCents: loaded.pricing.minimumMonthlyCents,
    perUserSubtotalCents: amounts.perUserSubtotalCents,
    platformFeeCents: amounts.platformFeeCents,
    platformFeeBasis: amounts.platformFeeBasis,
    billingFeeCents: amounts.billingFeeCents,
    oneTimeFeeCents: amounts.oneTimeFeeCents,
    minimumAdjustmentCents: amounts.minimumAdjustmentCents,
    totalCents: amounts.totalCents,
    computedAt: at,
    finalizedAt: finalize ? at : null,
  };
  const { organizationId: _o, subscriptionId: _s, periodYearMonth: _p, ...replaceable } = values;
  return tx
    .insert(SS)
    .values(values)
    .onConflictDoUpdate({
      target: [SS.subscriptionId, SS.periodYearMonth],
      set: { ...replaceable, updatedAt: at },
      // A draft is replaced; a final row is left exactly as it was (and its trigger would refuse the write anyway).
      setWhere: eq(SS.status, "draft"),
    })
    .returning();
}

async function pushToStripe(
  deps: StatementDeps,
  statementId: string,
  view: StatementView,
): Promise<void> {
  if (!deps.stripe) return; // the seam is unbound: see StatementStripePort
  try {
    const { usageRecordId } = await deps.stripe.pushFinalStatement(view);
    await deps.platformRunner((tx) =>
      tx
        .update(SS)
        .set({ stripeUsageRecordId: usageRecordId, stripePostedAt: new Date() })
        .where(eq(SS.id, statementId)),
    );
  } catch (error) {
    deps.log?.("m35 statement stripe push failed", {
      statementId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Compute the org's statements for the month just ended (finalized once its grace has passed) and the month in progress (draft).
 * Idempotent: a rerun replaces a draft with the same figures and leaves a final statement alone. Empty when the org has no contract.
 */
export async function runStatementsForOrg(
  deps: StatementDeps,
  organizationId: string,
): Promise<StatementOutcome[]> {
  const at = (deps.now ?? (() => new Date()))();
  const current = calendarMonthOf(at);
  return statementsForOrg(deps, organizationId, [previousCalendarMonth(current), current], at);
}
