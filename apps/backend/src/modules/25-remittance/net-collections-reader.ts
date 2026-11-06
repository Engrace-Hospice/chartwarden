// apps/backend/src/modules/25-remittance/net-collections-reader.ts — M25's `NetCollectionsReader` seam impl (slice 2, tenant pricing).
//
// The meter the M35 billing-service percentage is charged on: an organisation's NET COLLECTIONS for a period.
//
//   net collections = the sum of `remittance_advice.total_payment_amount` (835 BPR02) over the org's remittances that are
//                     posted or partially posted and whose PAYMENT DATE (`production_date`, BPR16: the EFT effective / check
//                     issue date, the day the money moved, not the day we parsed the file) falls in [periodStart, periodEnd).
//
// BPR02 is already NET: the parser refuses an 835 unless `sum(CLP04 claim payments) - sum(PLB provider-level adjustments) = BPR02`,
// and a claim reversal carries a negative CLP04 while an overpayment recovery or takeback rides a PLB adjustment, so everything
// that reduces the payment INSIDE a remittance is netted before it reaches this column. What this meter cannot see, and the report
// to the owner says so: a takeback that arrives as its own debit (BPR03 = D) or as a remittance that nets below zero is REFUSED at
// ingest (`parse-x12-835`: "debit remittances are unsupported", "BPR02 is negative") and so is never recorded. Remittances that arrived
// but are not posted yet (queued / parsing / parsed / failed) are COUNTED in `pendingCount`, never silently dropped.
//
// Payer kinds medicare, medicaid and commercial all land in `remittance_advice`: M25 ingests every 835 and M41 only consumes M25's
// posting events to move its claims (ADR-0100 D8; it holds no payment ledger of its own), so one query covers every payer. Aggregate dollars only: no claim id, patient row or MBI leaves M25.
// Runs under `withOrgContext` (RLS scopes it to the asked org); a worker calls it, hence the org-explicit signature.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import type {
  NetCollections,
  NetCollectionsMonth,
  NetCollectionsReader,
  OrgId,
} from "@chartwarden/types";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { refuseForeignAmbientOrg } from "../../bootstrap/ambient-org-guard";

const RA = schema.remittanceAdvice;
const POSTED = sql`${RA.parseStatus} IN ('posted', 'partial_posted')`;
// total_payment_amount is dollars numeric(12,2); the contract is integer cents.
const CENTS = sql<string>`coalesce(sum(round(${RA.totalPaymentAmount} * 100)) FILTER (WHERE ${POSTED}), 0)::bigint`;
const POSTED_COUNT = sql<string>`count(*) FILTER (WHERE ${POSTED})`;
const PENDING_COUNT = sql<string>`count(*) FILTER (WHERE NOT (${POSTED}))`;
/** The UTC calendar month of the payment date, `YYYY-MM`. */
const PAYMENT_MONTH = sql<string>`to_char(${RA.productionDate} AT TIME ZONE 'UTC', 'YYYY-MM')`;

interface Period {
  readonly periodStart: Date;
  readonly periodEnd: Date;
}

const toNetCollections = (
  row: { cents: string; posted: string; pending: string } | undefined,
): NetCollections => ({
  netCents: Number(row?.cents ?? 0),
  remittanceCount: Number(row?.posted ?? 0),
  pendingCount: Number(row?.pending ?? 0),
});

function checkedPeriod(organizationId: string, { periodStart, periodEnd }: Period): void {
  refuseForeignAmbientOrg(organizationId, "NetCollectionsReader");
  if (!(periodStart < periodEnd)) throw new RangeError("periodStart must be before periodEnd");
}

export function buildNetCollectionsReader(db: DbClient): NetCollectionsReader {
  const inPeriod = (organizationId: string, { periodStart, periodEnd }: Period) =>
    and(
      eq(RA.organizationId, organizationId),
      gte(RA.productionDate, periodStart),
      lt(RA.productionDate, periodEnd),
    );

  return {
    async netCollectionsForPeriod(organizationId: OrgId, period: Period): Promise<NetCollections> {
      checkedPeriod(organizationId, period);
      return withOrgContext(db, { organizationId, userId: "system" }, async (tx) => {
        const [row] = await tx
          .select({ cents: CENTS, posted: POSTED_COUNT, pending: PENDING_COUNT })
          .from(RA)
          .where(inPeriod(organizationId, period));
        return toNetCollections(row);
      });
    },

    async netCollectionsByMonth(
      organizationId: OrgId,
      period: Period,
    ): Promise<NetCollectionsMonth[]> {
      checkedPeriod(organizationId, period);
      return withOrgContext(db, { organizationId, userId: "system" }, async (tx) => {
        const rows = await tx
          .select({
            yearMonth: PAYMENT_MONTH,
            cents: CENTS,
            posted: POSTED_COUNT,
            pending: PENDING_COUNT,
          })
          .from(RA)
          .where(inPeriod(organizationId, period))
          .groupBy(PAYMENT_MONTH)
          .orderBy(PAYMENT_MONTH);
        return rows.map((row) => ({ yearMonth: row.yearMonth, ...toNetCollections(row) }));
      });
    },
  };
}
