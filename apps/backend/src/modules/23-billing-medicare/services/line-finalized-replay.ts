// apps/backend/src/modules/23-billing-medicare/services/line-finalized-replay.ts - GAP-038. The platform-ops
// read side of the cap-day backfill. M26 cannot read `claim` / `claim_line` / `claim_state_history`
// (`allowedTables(26)` is its own tables only), so the history lives here: this walks the claims that have EVER
// been paid and, per claim,
//   * still PAID / PARTIAL_PAID  -> re-emits the same `m23.claim.line_finalized` the 835 posting emitted
//     (`buildClaimLineFinalizedEmissions`), dated by the claim's latest paid transition so M26 attributes the days
//     to the right cap year and stamps the claim identity on rows written before it existed;
//   * no longer paid (replaced / voided / recouped back to ACK_ACCEPTED) -> returns a reversal candidate for the
//     operator runner to hand to M26. Its day lines were recorded when it was paid and, written before the
//     ledger carried a claim id, can only be found by their claim_line ids. NOTHING is emitted for these:
//     re-announcing a payment that was taken back would re-count it.
//
// Replay is safe to repeat: M26's ledger key dedups, and the event bus is at-least-once already. It re-delivers to
// EVERY declared consumer of `m23.claim.line_finalized` (M26, and M33 by seam), not only M26. It is a platform-ops
// operation (the CLI `scripts/backfill-line-finalized.ts`); there is deliberately no tenant HTTP route.
//
// Dating note: the finalized instant is `claim_state_history.at`, the instant the PAID transition was written -
// the same ingest transaction as the 835 posting (`m25-remittance.ts`), not the 835's own `postedAt` (M23 cannot
// read M25's tables). They differ only by ingest latency, which matters solely for a payment ingested across a
// cap-year boundary.
import { type ClaimState, repositories } from "@chartwarden/billing";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  buildClaimLineFinalizedEmissions,
  isHospiceLocRevenueCode,
} from "../outbox-consumers/claim-line-finalized";
import type { BillingDb, WriteOutboxPort } from "./claim-state-service";

export const REPLAY_DEFAULT_PAGE_SIZE = 100;
export const REPLAY_MAX_PAGE_SIZE = 500;

const PAID_STATES: ReadonlySet<ClaimState> = new Set<ClaimState>(["paid", "partial_paid"]);

/** A claim that was paid and no longer is: its recorded day lines must stop counting (M26 reverses them). */
export interface ClaimDayReversalCandidate {
  readonly claimId: string;
  /** The claim's hospice level-of-care claim_line ids (the ledger's `source_id`). */
  readonly claimLineIds: readonly string[];
  /** When the claim left the paid state (ISO-8601). */
  readonly reversedAt: string;
}

export interface LineFinalizedReplayPage {
  readonly claimsScanned: number;
  readonly claimsReplayed: number;
  readonly linesEmitted: number;
  readonly reversals: readonly ClaimDayReversalCandidate[];
  /**
   * Still-paid claims NOT replayed because their cap year is not one the caller allowed (never opened, or sealed),
   * counted per cap year. Reported, never silent.
   */
  readonly skippedByCapYear: Readonly<Record<string, number>>;
  /** Pass back as `afterClaimId` for the next page; `null` once the org is exhausted. */
  readonly nextCursor: string | null;
}

export interface LineFinalizedReplayInput {
  readonly organizationId: string;
  readonly afterClaimId?: string;
  readonly limit?: number;
  /**
   * Only replay a still-paid claim whose payment falls in one of these cap years. Both fields travel together
   * (M23 does not own the cap-year calendar; the runner passes M26's `capYearForDate`). Omitted = every year.
   */
  readonly capYearFilter?: {
    readonly allowed: ReadonlySet<string>;
    readonly capYearOf: (isoInstant: string) => string;
  };
}

/** Clamp a caller-supplied page size into [1, REPLAY_MAX_PAGE_SIZE]. */
export function clampReplayPageSize(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return REPLAY_DEFAULT_PAGE_SIZE;
  return Math.min(REPLAY_MAX_PAGE_SIZE, Math.max(1, Math.floor(limit)));
}

/** Whether a claim in `state` still holds a payment (so its day lines are live), per the claim lifecycle. */
export function claimStillHoldsPayment(state: ClaimState): boolean {
  return PAID_STATES.has(state);
}

/**
 * Replay one keyset page (by claim id) for ONE organization, in one org-scoped transaction. The emissions
 * commit with the page (the transactional outbox), so a failed page emits nothing.
 */
export async function replayLineFinalizedPage(
  db: BillingDb,
  outbox: WriteOutboxPort,
  input: LineFinalizedReplayInput,
): Promise<LineFinalizedReplayPage> {
  const limit = clampReplayPageSize(input.limit);
  const { organizationId } = input;
  return withOrgContext(db, { organizationId, userId: "" }, async (tx) => {
    const history = new repositories.ClaimStateHistoryRepository(tx);
    const claims = new repositories.ClaimRepository(tx);
    const lines = new repositories.ClaimLineRepository(tx);
    const page = await history.listPaidTransitionsPage(input.afterClaimId, limit);

    let claimsReplayed = 0;
    let linesEmitted = 0;
    const reversals: ClaimDayReversalCandidate[] = [];
    const skippedByCapYear: Record<string, number> = {};
    for (const summary of page) {
      const claim = await claims.findById(summary.claimId);
      if (!claim || claim.organizationId !== organizationId) continue;
      const claimLines = await lines.listForClaim(claim.id);
      if (claimStillHoldsPayment(claim.state)) {
        const paidAtIso = summary.paidAt.toISOString();
        const filter = input.capYearFilter;
        const capYear = filter?.capYearOf(paidAtIso);
        if (filter && capYear !== undefined && !filter.allowed.has(capYear)) {
          skippedByCapYear[capYear] = (skippedByCapYear[capYear] ?? 0) + 1;
          continue;
        }
        const emissions = buildClaimLineFinalizedEmissions({
          organizationId,
          claimId: claim.id,
          patientId: claim.patientId,
          lines: claimLines,
          finalizedAt: paidAtIso,
        });
        for (const emission of emissions) await outbox.publish(tx, emission);
        claimsReplayed += 1;
        linesEmitted += emissions.length;
        continue;
      }
      const claimLineIds = claimLines
        .filter((line) => isHospiceLocRevenueCode(line.revenueCode))
        .map((line) => line.id);
      if (claimLineIds.length === 0) continue;
      reversals.push({
        claimId: claim.id,
        claimLineIds,
        reversedAt: (summary.leftPaidAt ?? summary.paidAt).toISOString(),
      });
    }
    const last = page[page.length - 1];
    return {
      claimsScanned: page.length,
      claimsReplayed,
      linesEmitted,
      reversals,
      skippedByCapYear,
      nextCursor: page.length === limit && last ? last.claimId : null,
    };
  });
}
