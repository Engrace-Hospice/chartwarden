// apps/backend/src/modules/27-cost-report/routes/cap-context.ts — the M27 cap-context RESOLVER (the M26
// cost-report cap bind). Resolves M26's published `CapAccrualReader` seam (registered into the M1 registry by
// M26 at boot) and maps its cap-period aggregate to M27's own `CapContext` (the opaque rich-seam pattern —
// M27 casts the seam to a consumer-defined view, it does NOT import @wardenx/cap-management). This is the cap
// PORTION of the eventual full ValidationContextBuilder; the rest (worksheet totals / statistics / mapping /
// deadline) assembles in M27's own follow-up.
//
// Fail-closed (D13): a thrown SEAM_NOT_BOUND/NotImplementedError (the M1 deny-stub when M26 isn't db-bound) or
// a null result → `capProviderBound: false`, so the cap validation rules SKIP rather than fabricate a figure.
import type { CapContext } from "@wardenx/cost-report";

/** M27's consumer-defined view of M26's CapAccrualReader (cents-as-string; M27 parses to integer cents). */
export interface CapAggregateSeam {
  aggregateForCostReport(
    orgId: string,
    capYear: string,
  ): Promise<{
    aggregateCapCents: string;
    aggregatePaymentsCents: string;
    inpatientDays: number;
    totalMedicareDays: number;
  } | null>;
}

/** Resolves the live `CapAccrualReader` (production: `() => getSeam("CapAccrualReader") as CapAggregateSeam`). */
export type CapSeamResolver = () => CapAggregateSeam;

export interface ResolvedCapContext {
  readonly capContext: CapContext | null;
  readonly capProviderBound: boolean;
}

/**
 * Resolve the cost-report `CapContext` for an org + cap year via the M26 seam. Returns
 * `{ capContext: null, capProviderBound: false }` when M26 is unbound (deny-stub throws) or has no cap period
 * for that year — the fail-closed contract the cap validation rules read.
 */
export async function resolveCapContext(
  resolve: CapSeamResolver,
  orgId: string,
  capYear: string,
): Promise<ResolvedCapContext> {
  try {
    const seam = resolve();
    const agg = await seam.aggregateForCostReport(orgId, capYear);
    if (!agg) return { capContext: null, capProviderBound: false };
    return {
      capContext: {
        aggregateCapCents: Number(agg.aggregateCapCents),
        aggregatePaymentsCents: Number(agg.aggregatePaymentsCents),
        inpatientDays: agg.inpatientDays,
        totalMedicareDays: agg.totalMedicareDays,
      },
      capProviderBound: true,
    };
  } catch {
    return { capContext: null, capProviderBound: false };
  }
}
