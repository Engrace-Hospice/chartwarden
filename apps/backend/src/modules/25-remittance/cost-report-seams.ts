// apps/backend/src/modules/25-remittance/cost-report-seams.ts — M25's published-seam registration into the
// M1 SeamRegistry for the M27 cost-report E-1 settlement tie (the M23/M26 `register…PublishedSeams` precedent).
//
// Registers the §4.4 `ClaimSettlementProvider` so M27's Worksheet-E-1 settlement reconciliation resolves the
// live ACTUAL interim Medicare payments — the sum of the 835 claim-level payment (CLP04) over remittances
// RECEIVED in the fiscal year — via `getSeam` over the fail-closed deny-stub. M23 only carries EXPECTED
// payment; the actual posted dollars live here (the 835 posting), which is why the settlement seam is M25's.
// The read runs under `withOrgContext` (RLS-scoped); the aggregate is a single dollar total, no patient row
// and no MBI (D18). No db → the M1 deny-stub stands and the E-1↔D tie rule SKIPS.
import { type DbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { registerSeam } from "../../bootstrap/index";

const RL = schema.remittanceLine;

/** The M25 → M27 settlement seam contract. Opaque in the M1 registry (`unknown`); M27 casts to its own view. */
export interface ClaimSettlementProvider {
  /** Total ACTUAL interim Medicare payments (835 CLP04) received in the FY `[fyStartIso, fyEndIso]`, in
   *  integer cents. `fyEndIso` is inclusive (received_at is bounded by the day AFTER the FY end). */
  interimPaymentsForFiscalYear(
    orgId: string,
    fyStartIso: string,
    fyEndIso: string,
  ): Promise<{ interimPaymentsCents: number }>;
}

/** The ISO date one day after `isoDate` — the exclusive upper bound for an inclusive [start, end] day range. */
function dayAfter(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Build the live `ClaimSettlementProvider` over the M25 remittance ledger, RLS-scoped per call. */
export function buildM25ClaimSettlementProvider(db: DbClient): ClaimSettlementProvider {
  return {
    async interimPaymentsForFiscalYear(orgId, fyStartIso, fyEndIso) {
      const upperExclusive = dayAfter(fyEndIso);
      return withOrgContext(db, { organizationId: orgId, userId: "system" }, async (tx) => {
        const [row] = await tx
          .select({
            // CLP04 is dollars (numeric 12,2); the seam contract is integer cents → ×100, rounded.
            cents: sql<number>`coalesce(round(sum(${RL.clp04TotalPaymentAmount}) * 100), 0)::bigint`,
          })
          .from(RL)
          .where(
            and(
              eq(RL.organizationId, orgId),
              gte(RL.receivedAt, sql`${fyStartIso}::timestamptz`),
              lt(RL.receivedAt, sql`${upperExclusive}::timestamptz`),
            ),
          );
        return { interimPaymentsCents: Number(row?.cents ?? 0) };
      });
    },
  };
}

/** Register M25's published seams into the M1 registry. No-op without a db (the deny-stub stands). */
export function registerM25PublishedSeams(db: DbClient | undefined): void {
  if (!db) return;
  registerSeam("ClaimSettlementProvider", buildM25ClaimSettlementProvider(db));
}
