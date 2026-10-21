// @chartwarden/mdm — the pure §4.3 `mdm.provisional_aging_scan` planner (GAP-173, spec §4.3).
//
// "Scheduled weekly: provisional rows pending > 14 days → escalate to platform-ops." A tenant stages a provisional
// entity when `getOrCreate` finds no identifier match (§2.4.3); only platform-ops can promote or merge it, so one
// that sits unanswered is a stuck tenant workflow. Pure: the worker reads the org's `pending` rows and injects
// `now`; the plan groups them per org for ONE escalation notice (a weekly digest, not one page per row).

/** A provisional row's age is measured from `createdAt`. */
export const PROVISIONAL_AGING_THRESHOLD_DAYS = 14;
const MS_PER_DAY = 86_400_000;
/** At most this many ids are quoted in a notice (the rest are counted) — keeps a digest readable. */
export const PROVISIONAL_AGING_MAX_IDS = 20;

export interface ProvisionalRow {
  readonly id: string;
  readonly organizationId: string;
  readonly entityKind: string;
  readonly createdAt: Date;
}

export interface ProvisionalAgingPlan {
  readonly organizationId: string;
  /** Total pending rows older than the threshold. */
  readonly agedCount: number;
  /** Age in whole days of the oldest one. */
  readonly oldestAgeDays: number;
  /** Per entity kind counts. */
  readonly byKind: Readonly<Record<string, number>>;
  /** Up to {@link PROVISIONAL_AGING_MAX_IDS} ids, oldest first. */
  readonly sampleIds: readonly string[];
}

/** Plan the escalation for ONE org's pending provisionals, or `null` when none is past the threshold. */
export function planProvisionalAging(
  organizationId: string,
  pending: readonly ProvisionalRow[],
  now: Date,
): ProvisionalAgingPlan | null {
  const cutoff = now.getTime() - PROVISIONAL_AGING_THRESHOLD_DAYS * MS_PER_DAY;
  const aged = pending
    .filter((r) => r.createdAt.getTime() < cutoff)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const oldest = aged[0];
  if (oldest === undefined) return null;
  const byKind: Record<string, number> = {};
  for (const r of aged) byKind[r.entityKind] = (byKind[r.entityKind] ?? 0) + 1;
  return {
    organizationId,
    agedCount: aged.length,
    oldestAgeDays: Math.floor((now.getTime() - oldest.createdAt.getTime()) / MS_PER_DAY),
    byKind,
    sampleIds: aged.slice(0, PROVISIONAL_AGING_MAX_IDS).map((r) => r.id),
  };
}
