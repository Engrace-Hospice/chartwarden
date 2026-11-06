// apps/backend/src/modules/35-subscription/pricing/statement-service.ts — the MONTHLY STATEMENT run (slice 2, tenant pricing).
//
// One statement per subscription per UTC calendar month, computed from three meters and the plan VERSION the tenant signed:
//   staff     active staff accounts          ./staff-meter.ts   (the user_active_period ledger + the identity roles)
//   ADC       average daily census           ./census-daily.ts  (M5 PatientCensusReader, via the m35.patient-census sweep)
//   net coll. net collections of the month   the `NetCollectionsReader` seam (M25 remittance: see its header for the exact definition)
// and the pure math in @chartwarden/subscription-billing. The decisions (which months, which late money, which figures) are the pure
// functions of ./statement-plan.ts and the calendar of ./statement-period.ts; this file is the orchestration around them.
//
// LIFECYCLE. The month in progress is a `draft`, recomputed on every sweep and rewritten only when a figure changed (the row is unique on
// (subscription, month); a rerun that changes nothing writes nothing, so it leaves no audit row). A month is finalized by the first sweep
// at or after its end plus STATEMENT_FINALIZE_GRACE_DAYS, and a final row is never recomputed (a trigger freezes it). Money that posts
// after that is billed on the next open statement as a prior-period line (never lost, never re-billing the closed month).
//
// WHO IS SWEPT. Statements do NOT depend on the active-organisation sweep: the worker asks the ONE shared contract selector which orgs can
// still need a statement, so the last month of a suspended or closed organisation, and a canceled subscription's final month, still
// finalize. A month is decided from the subscription's own lifetime (go-live, pauses, cancel), not from its status today: a closed month
// finalizes whatever the subscription has become since, the month it was canceled in is billed for the days used, and months after that
// are not billed at all. The one-time implementation fee rides the first statement the subscription ever has.
//
// Writes run on the platform runner only, under a per-organisation advisory lock (two runs for one org are serialized, so a month is
// never written twice and the one-time fee and the prior-period lines are judged on the state the first run left). A tenant holds SELECT.
import { schema } from "@chartwarden/db";
import type { PseudonymKeyProvider } from "@chartwarden/subscription-billing";
import type { NetCollections, NetCollectionsReader, OrgId } from "@chartwarden/types";
import { eq, sql } from "drizzle-orm";
import type { PlatformRunner, WriteTx } from "../routes/service-drizzle";
import { readDailyCensus } from "./census-daily";
import type { GoLiveReader } from "./ports";
import { type StaffCount, countActiveStaffForMonth } from "./staff-meter";
import { loadContractFacts, toExisting } from "./statement-inputs";
import { type MonthPeriod, calendarMonthOf } from "./statement-period";
import {
  type ContractFacts,
  type ExistingStatement,
  type MonthMeters,
  type MonthWork,
  buildStatementValues,
  figuresOf,
  planMonths,
  priorPeriodLinesFor,
} from "./statement-plan";
import { type StatementStripePort, type StatementView, toStatementView } from "./statement-view";

export {
  type MonthPeriod,
  STATEMENT_FINALIZE_GRACE_DAYS,
  calendarMonthOf,
  isFinalizable,
  previousCalendarMonth,
} from "./statement-period";
export {
  type PriorPeriodLineView,
  type StatementStripePort,
  type StatementView,
  toStatementView,
} from "./statement-view";

const SS = schema.subscriptionStatement;
const SSR = schema.subscriptionStatementReview;
const NO_COLLECTIONS: NetCollections = { netCents: 0, remittanceCount: 0, pendingCount: 0 };
const NO_STAFF: StaffCount = { count: 0, basis: "identity_filtered" };

export interface StatementDeps {
  readonly platformRunner: PlatformRunner;
  readonly keyProvider: PseudonymKeyProvider;
  readonly netCollections: NetCollectionsReader;
  /** When the tenant went live (M34 owns it). Without it no statement is computed. */
  readonly goLive: GoLiveReader;
  readonly stripe?: StatementStripePort;
  readonly now?: () => Date;
  readonly log?: (message: string, detail: Record<string, unknown>) => void;
}

export type StatementOutcome =
  | { readonly outcome: "written"; readonly statement: StatementView }
  | { readonly outcome: "unchanged"; readonly periodYearMonth: string }
  | {
      readonly outcome: "skipped";
      readonly periodYearMonth: string;
      readonly reason: "final" | "no_census" | "no_prior_period";
    };

type StatementRow = typeof SS.$inferSelect;
type NetByMonth = ReadonlyMap<string, NetCollections>;

const clockOf = (deps: Pick<StatementDeps, "now">): Date => (deps.now ?? (() => new Date()))();

/** Per-organisation lock: two runs for one org never interleave their writes. Transaction-scoped, nothing to release. */
const lockOrgStatements = (tx: WriteTx, organizationId: string) =>
  tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`m35-statement:${organizationId}`}::text, 0))`,
  );

/** M25's collections for the whole range the run may touch, by payment month: ONE call, read under the org's RLS before the write. */
async function readCollectionsByMonth(
  deps: StatementDeps,
  organizationId: string,
  contracts: readonly ContractFacts[],
  at: Date,
): Promise<NetByMonth> {
  const first = contracts.reduce(
    (min, c) => (c.liveFrom < min ? c.liveFrom : min),
    contracts[0]?.liveFrom ?? at,
  );
  // A failure throws; it is never recorded as zero collections.
  const months = await deps.netCollections.netCollectionsByMonth(organizationId as OrgId, {
    periodStart: calendarMonthOf(first).start,
    periodEnd: calendarMonthOf(at).end,
  });
  return new Map(months.map((m) => [m.yearMonth, m]));
}

async function readMeters(
  tx: WriteTx,
  deps: StatementDeps,
  contract: ContractFacts,
  period: MonthPeriod,
  net: NetByMonth,
): Promise<MonthMeters> {
  const daily = await readDailyCensus(tx, contract.organizationId, period);
  const staff = await countActiveStaffForMonth(
    tx,
    deps.keyProvider,
    contract.organizationId,
    period,
  );
  return { daily, staff, collections: net.get(period.key) ?? NO_COLLECTIONS };
}

/** Insert or replace one month's row; [] when the row was already final (a final row is left exactly as it was). */
async function upsertStatement(
  tx: WriteTx,
  values: ReturnType<typeof buildStatementValues>,
  at: Date,
): Promise<StatementRow[]> {
  const { organizationId: _o, subscriptionId: _s, periodYearMonth: _p, ...replaceable } = values;
  return tx
    .insert(SS)
    .values(values)
    .onConflictDoUpdate({
      target: [SS.subscriptionId, SS.periodYearMonth],
      set: { ...replaceable, updatedAt: at },
      // A draft is replaced; a final row is left alone (and its trigger would refuse the write anyway).
      setWhere: eq(SS.status, "draft"),
    })
    .returning();
}

interface MonthResult {
  readonly outcome: StatementOutcome;
  readonly written?: StatementRow;
}

/**
 * A closed month of a live subscription with no census day: record it ONCE (the table is unique on subscription, month, reason) and
 * log it once, with the organisation, when the row is new. A rerun every hour finds the row and says nothing.
 */
async function flagNoCensus(
  tx: WriteTx,
  deps: StatementDeps,
  contract: ContractFacts,
  periodYearMonth: string,
): Promise<void> {
  const inserted = await tx
    .insert(SSR)
    .values({
      subjectOrganizationId: contract.organizationId,
      subscriptionId: contract.subscriptionId,
      periodYearMonth,
      reason: "no_census",
    })
    .onConflictDoNothing()
    .returning({ id: SSR.id });
  if (inserted.length === 0) return;
  deps.log?.("m35 statement month closed with no census day; not billed, flagged for review", {
    organizationId: contract.organizationId,
    subscriptionId: contract.subscriptionId,
    periodYearMonth,
  });
}

/** One month of one contract: meters, prior-period lines, figures; then skip, leave alone, or write. */
async function runMonth(
  tx: WriteTx,
  deps: StatementDeps,
  contract: ContractFacts,
  work: MonthWork,
  statements: readonly ExistingStatement[],
  net: NetByMonth,
  at: Date,
): Promise<MonthResult> {
  const key = work.period.key;
  // A settlement month was not live: no meter is read for it (buildStatementValues zeroes the inputs).
  const meters = work.settlement
    ? { daily: [], staff: NO_STAFF, collections: NO_COLLECTIONS }
    : await readMeters(tx, deps, contract, work.period, net);
  if (!work.settlement && meters.daily.length === 0) {
    // The org was live and swept none of the month: not billed (a missing census is not a census of zero). A CLOSED month is a data
    // hole an operator must see: flagged once per subscription-month, not logged every hour.
    if (work.finalize) await flagNoCensus(tx, deps, contract, key);
    return { outcome: { outcome: "skipped", periodYearMonth: key, reason: "no_census" } };
  }
  const priorLines = priorPeriodLinesFor(work.period, statements, net);
  const stored = statements.find((s) => s.periodYearMonth === key);
  // A settlement month is written only when it has late money to carry, or when it is already a stored draft that must now finalize.
  if (work.settlement && priorLines.length === 0 && !stored) {
    return { outcome: { outcome: "skipped", periodYearMonth: key, reason: "no_prior_period" } };
  }
  const values = buildStatementValues({
    facts: contract,
    work,
    meters,
    priorLines,
    isFirstStatement: !statements.some((s) => s.periodYearMonth < key),
    at,
  });
  if (stored?.status === "draft" && stored.figures === figuresOf(values)) {
    return { outcome: { outcome: "unchanged", periodYearMonth: key } };
  }
  const [row] = await upsertStatement(tx, values, at);
  if (!row) return { outcome: { outcome: "skipped", periodYearMonth: key, reason: "final" } };
  return {
    outcome: { outcome: "written", statement: toStatementView(row, contract.currencyCode) },
    written: row,
  };
}

/** Every month of one contract that needs a statement, oldest first; each write is visible to the months after it (a month closed in
 *  this run is a final statement whose lines the next month must not carry again). */
async function runContract(
  tx: WriteTx,
  deps: StatementDeps,
  contract: ContractFacts,
  net: NetByMonth,
  at: Date,
): Promise<MonthResult[]> {
  let statements: readonly ExistingStatement[] = contract.statements;
  const results: MonthResult[] = [];
  for (const work of planMonths(contract, at)) {
    const result = await runMonth(tx, deps, contract, work, statements, net, at);
    results.push(result);
    if (result.written) {
      statements = [
        ...statements.filter((s) => s.periodYearMonth !== work.period.key),
        toExisting(result.written),
      ];
    }
  }
  return results;
}

async function pushToStripe(
  deps: StatementDeps,
  row: StatementRow,
  currency: string,
): Promise<void> {
  if (!deps.stripe || row.status !== "final") return; // the seam is unbound: see StatementStripePort
  try {
    const { usageRecordId } = await deps.stripe.pushFinalStatement(toStatementView(row, currency));
    await deps.platformRunner((tx) =>
      tx
        .update(SS)
        .set({ stripeUsageRecordId: usageRecordId, stripePostedAt: new Date() })
        .where(eq(SS.id, row.id)),
    );
  } catch (error) {
    deps.log?.("m35 statement stripe push failed", {
      statementId: row.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const byPeriod = (a: StatementOutcome, b: StatementOutcome): number =>
  periodOf(a).localeCompare(periodOf(b));
const periodOf = (o: StatementOutcome): string =>
  o.outcome === "written" ? o.statement.periodYearMonth : o.periodYearMonth;

/**
 * Compute the org's statements: every month since go-live that is not final yet (finalized once its grace has passed, draft while it is
 * open), plus a settlement statement when a closed month's late-posted money has no open month to ride. Idempotent: a rerun replaces a
 * draft only when a figure moved and leaves a final statement alone. Empty when the org has no contract that can still bill, or is not live.
 */
export async function runStatementsForOrg(
  deps: StatementDeps,
  organizationId: string,
): Promise<StatementOutcome[]> {
  const at = clockOf(deps);
  const planned = await deps.platformRunner((tx) =>
    loadContractFacts(tx, deps.goLive, organizationId, at),
  );
  if (planned.length === 0) return [];
  const net = await readCollectionsByMonth(deps, organizationId, planned, at);

  const done = await deps.platformRunner(async (tx) => {
    await lockOrgStatements(tx, organizationId);
    // Re-read under the lock: what is written is judged on the state the last run left, not the state before it.
    const facts = await loadContractFacts(tx, deps.goLive, organizationId, at);
    const out: { currency: string; result: MonthResult }[] = [];
    for (const contract of facts) {
      for (const result of await runContract(tx, deps, contract, net, at)) {
        out.push({ currency: contract.currencyCode, result });
      }
    }
    return out;
  });
  for (const { currency, result } of done) {
    if (result.written) await pushToStripe(deps, result.written, currency);
  }
  return done.map((d) => d.result.outcome).sort(byPeriod);
}
