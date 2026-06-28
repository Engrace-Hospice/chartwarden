// @wardenx/quality — M30 §7.2 (WF-06) CAHPS result-ingest transform + min-cell suppression. Pure, IO-free.
//
// A vendor's `parseResultIngest` returns the raw per-period aggregate it found in the upload. Before those
// aggregates are persisted as `cahps_result_summary` rows, CMS small-cell protection applies: any reporting
// cell with ≤ the vendor's minimum cell size (≥30 per CMS protocol) must NOT publish its scores. This
// module is the pure transform the ingest worker runs between parse and insert — it suppresses the
// score payloads of under-sized cells (blanking `topBoxPercentages` / `compositeScores` to `{}`) while
// retaining the aggregate counts and the dedup hash so the row is still an auditable "results were
// ingested" record. No DB, no I/O.
import { WardenXError } from "@wardenx/types";
import type { schema } from "@wardenx/db";
import type { CahpsResultSummaryInput, CahpsVendorAdapterId } from "./adapter";

/**
 * One raw result row as a vendor adapter parsed it (pre-suppression). Structurally the persisted-input
 * shape; suppression is applied to produce the `CahpsResultSummaryInput` actually written.
 */
export interface ParsedCahpsResultRow {
  readonly providerEntityId: string;
  readonly reportingPeriodStart: string;
  readonly reportingPeriodEnd: string;
  readonly vendorAdapterId: CahpsVendorAdapterId;
  readonly topBoxPercentages: schema.CahpsTopBoxPercentages;
  readonly compositeScores: schema.CahpsCompositeScores;
  readonly responseCount: number;
  readonly attemptedSampleCount: number;
  readonly responseRate: number | null;
  readonly vendorResponsePayloadHash: string;
}

/** A note that one cell was score-suppressed for being at/under the minimum cell size. */
export interface SuppressedCell {
  readonly providerEntityId: string;
  readonly reportingPeriodStart: string;
  readonly reportingPeriodEnd: string;
  readonly responseCount: number;
}

/** The outcome of {@link applyMinimumCellSuppression}: rows to persist + the suppression audit list. */
export interface MinCellSuppressionResult {
  readonly inputs: CahpsResultSummaryInput[];
  readonly suppressed: SuppressedCell[];
}

const EMPTY_TOP_BOX: schema.CahpsTopBoxPercentages = {};
const EMPTY_COMPOSITES: schema.CahpsCompositeScores = {};

/** Validate one raw row's aggregate counts before it is transformed (fail closed on impossible counts). */
function assertCounts(row: ParsedCahpsResultRow): void {
  if (!Number.isInteger(row.responseCount) || row.responseCount < 0) {
    throw new WardenXError("VALIDATION_FAILED", "responseCount must be a non-negative integer", 422);
  }
  if (!Number.isInteger(row.attemptedSampleCount) || row.attemptedSampleCount < 0) {
    throw new WardenXError("VALIDATION_FAILED", "attemptedSampleCount must be a non-negative integer", 422);
  }
  if (row.responseCount > row.attemptedSampleCount) {
    throw new WardenXError(
      "VALIDATION_FAILED",
      "responseCount cannot exceed attemptedSampleCount",
      422,
    );
  }
}

/**
 * Apply CMS minimum-cell-size suppression (WF-06). For each parsed row, if `responseCount <=
 * minimumCellSize` the score payloads are blanked to `{}` (the small-cell scores must not be published)
 * and the row is recorded in `suppressed`; otherwise the row passes through with its scores intact. The
 * aggregate counts, response rate, and dedup hash are always retained so the persisted row remains a
 * faithful, idempotent "results ingested" record.
 *
 * Pure. Throws `VALIDATION_FAILED` on a non-positive `minimumCellSize` or impossible counts.
 */
export function applyMinimumCellSuppression(
  rows: readonly ParsedCahpsResultRow[],
  minimumCellSize: number,
): MinCellSuppressionResult {
  if (!Number.isInteger(minimumCellSize) || minimumCellSize < 1) {
    throw new WardenXError("VALIDATION_FAILED", "minimumCellSize must be a positive integer", 422);
  }

  const inputs: CahpsResultSummaryInput[] = [];
  const suppressed: SuppressedCell[] = [];

  for (const row of rows) {
    assertCounts(row);
    const suppress = row.responseCount <= minimumCellSize;
    if (suppress) {
      suppressed.push({
        providerEntityId: row.providerEntityId,
        reportingPeriodStart: row.reportingPeriodStart,
        reportingPeriodEnd: row.reportingPeriodEnd,
        responseCount: row.responseCount,
      });
    }
    inputs.push({
      providerEntityId: row.providerEntityId,
      reportingPeriodStart: row.reportingPeriodStart,
      reportingPeriodEnd: row.reportingPeriodEnd,
      vendorAdapterId: row.vendorAdapterId,
      topBoxPercentages: suppress ? EMPTY_TOP_BOX : row.topBoxPercentages,
      compositeScores: suppress ? EMPTY_COMPOSITES : row.compositeScores,
      responseCount: row.responseCount,
      attemptedSampleCount: row.attemptedSampleCount,
      responseRate: row.responseRate,
      vendorResponsePayloadHash: row.vendorResponsePayloadHash,
    });
  }

  return { inputs, suppressed };
}
