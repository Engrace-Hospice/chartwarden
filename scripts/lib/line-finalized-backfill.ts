/**
 * WardenX - the cap-day backfill runner (GAP-038), the glue between the two modules that own its halves.
 *
 * M23 owns the claim history (`replayLineFinalizedPage`), M26 owns the day ledger and cannot read M23's tables, so
 * neither can call the other: this runner, outside both, pages M23's replay and hands each result to M26.
 *   - still-paid claims in a cap year the tenant has OPENED are re-announced as `m23.claim.line_finalized` through
 *     the real catalog-validating publisher; the normal dispatcher then delivers them to M26, whose ledger dedups
 *     and stamps claim identity on rows written before it existed;
 *   - claims that were paid and no longer are (replaced / voided / recouped) have their day lines reversed in M26
 *     directly, by claim_line id;
 *   - cap years with no open `cap_period`, or whose period is sealed, are REPORTED and not written.
 * It never recomputes: the roll-up is rebuilt from the ledger and the projection recomputed by the nightly tick
 * (`jobs/index.ts`), after the dispatcher has drained the replayed events. Safe to run again.
 */
import { capYearForDate } from "@chartwarden/cap-management";
import type {
  BillingDb,
  WriteOutboxPort,
} from "../../apps/backend/src/modules/23-billing-medicare/services/claim-state-service";
import { replayLineFinalizedPage } from "../../apps/backend/src/modules/23-billing-medicare/services/line-finalized-replay";
import type { CapBackfillPorts } from "../../apps/backend/src/modules/26-cap/consumers/backfill-ports";
import type { CapConsumerStore } from "../../apps/backend/src/modules/26-cap/consumers/handlers";

export interface LineFinalizedBackfillDeps {
  readonly db: BillingDb;
  readonly outbox: WriteOutboxPort;
  readonly store: Pick<CapConsumerStore, "reverseInpatientDays">;
  readonly capYears: CapBackfillPorts;
  readonly pageSize?: number;
}

export interface SkippedCapYear {
  readonly capYear: string;
  readonly claims: number;
  /** `no_cap_period` (the tenant never opened tracking: a product act) or `sealed:<status>`. */
  readonly reason: string;
}

export interface LineFinalizedBackfillReport {
  readonly organizationId: string;
  readonly claimsScanned: number;
  readonly claimsReplayed: number;
  readonly linesEmitted: number;
  readonly claimsReversed: number;
  readonly dayLinesReversed: number;
  readonly skippedCapYears: readonly SkippedCapYear[];
}

/** Run the backfill for ONE organization to completion. */
export async function runLineFinalizedBackfill(
  deps: LineFinalizedBackfillDeps,
  organizationId: string,
): Promise<LineFinalizedBackfillReport> {
  const years = await deps.capYears.capYearsForBackfill(organizationId);
  const capYearFilter = {
    allowed: years.backfillable,
    capYearOf: (iso: string) => capYearForDate(iso.slice(0, 10)),
  };
  let claimsScanned = 0;
  let claimsReplayed = 0;
  let linesEmitted = 0;
  let claimsReversed = 0;
  let dayLinesReversed = 0;
  const skipped = new Map<string, number>();
  let cursor: string | undefined;
  do {
    const page = await replayLineFinalizedPage(deps.db, deps.outbox, {
      organizationId,
      ...(cursor ? { afterClaimId: cursor } : {}),
      ...(deps.pageSize ? { limit: deps.pageSize } : {}),
      capYearFilter,
    });
    claimsScanned += page.claimsScanned;
    claimsReplayed += page.claimsReplayed;
    linesEmitted += page.linesEmitted;
    for (const [capYear, n] of Object.entries(page.skippedByCapYear)) {
      skipped.set(capYear, (skipped.get(capYear) ?? 0) + n);
    }
    for (const reversal of page.reversals) {
      const { reversed } = await deps.store.reverseInpatientDays({
        organizationId,
        claimId: reversal.claimId,
        claimLineIds: reversal.claimLineIds,
        reversedAt: reversal.reversedAt,
      });
      if (reversed > 0) claimsReversed += 1;
      dayLinesReversed += reversed;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  const skippedCapYears = [...skipped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([capYear, claims]) => ({
      capYear,
      claims,
      reason: years.sealed.has(capYear) ? `sealed:${years.sealed.get(capYear)}` : "no_cap_period",
    }));
  return {
    organizationId,
    claimsScanned,
    claimsReplayed,
    linesEmitted,
    claimsReversed,
    dayLinesReversed,
    skippedCapYears,
  };
}
