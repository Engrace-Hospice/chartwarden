// apps/backend/src/modules/26-cap/cap-period-selection.ts — which cap period a cost-report aggregate reads (GAP-149).
//
// `CapAccrualReader.aggregateForCostReport` used to take "the first row for the cap year", which for an org
// with two CCNs (two provider entities, each its own Medicare provider number and its own cap) returned an
// arbitrary one of them: the cost report for CCN B validated against CCN A's cap and payments, silently. A cap
// period is unique per (org, CCN, cap year) (`cap_period_org_ccn_year_uq`), so the CCN is the key.
//
// TRANSITION: `openPeriod` still writes every period's `ccn` as the sentinel {@link UNBOUND_CAP_CCN} pending the
// M40 CCN bind (see `routes/write-service-drizzle.ts`), so a period with the sentinel means "not yet bound to a
// CCN" and is the org's single period for the year. Selection therefore is:
//   * a period whose `ccn` equals the requested CCN                 — always wins;
//   * else exactly ONE sentinel period                              — the not-yet-CCN-bound org (today's norm);
//   * `ccn` omitted and exactly one period                          — the single-period org;
//   * anything else (several candidates, no exact match)            — AMBIGUOUS: null. Picking one would
//     fabricate a figure for the others, and the cost-report cap rules SKIP on null (D13 fail-closed).
/** The placeholder CCN `openPeriod` writes until the M40 CCN bind lands. */
export const UNBOUND_CAP_CCN = "000000";

export interface CapPeriodCandidate {
  readonly id: string;
  readonly ccn: string;
}

export function selectCapPeriodForCcn<T extends CapPeriodCandidate>(
  periods: readonly T[],
  ccn?: string | null,
): T | null {
  if (ccn) {
    const exact = periods.find((p) => p.ccn === ccn);
    if (exact) return exact;
    const unbound = periods.filter((p) => p.ccn === UNBOUND_CAP_CCN);
    return unbound.length === 1 ? (unbound[0] ?? null) : null;
  }
  return periods.length === 1 ? (periods[0] ?? null) : null;
}
