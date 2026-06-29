// apps/backend/src/modules/24-billing-medicaid/jobs/m24-jobs.ts — the M24 §4.9 pure cron handlers over
// injected stores (no bullmq, no Drizzle import — deterministic + unit-testable). Each cron fans out per
// active org; the store does the org-scoped read/write under withOrgContext at the call site. The real store
// bindings (ack pull from the state adapter, eligibility stale sweep, rb_day daily sweep from the M6 LOC
// snapshot, state-channel health probe) are deferred — they bind with the per-state adapter (the M26 posture).

export interface EligibilityWatchdogStore {
  staleEligibilityCount(orgId: string, asOf: string): Promise<number>;
}
export interface RbDaySweepStore {
  sweepPendingDays(orgId: string, asOf: string): Promise<number>;
}

/** Daily: count eligibility checks past their 30-day staleAt (drives the stale-at-assembly alert). */
export async function runEligibilityStaleWatchdog(
  store: EligibilityWatchdogStore,
  orgId: string,
  asOf: string,
): Promise<{ stale: number }> {
  return { stale: await store.staleEligibilityCount(orgId, asOf) };
}

/** Daily: materialize pending rb_days up to the as-of date from the M6 LOC snapshot (sweep). */
export async function runRbDayDailySweep(
  store: RbDaySweepStore,
  orgId: string,
  asOf: string,
): Promise<{ swept: number }> {
  return { swept: await store.sweepPendingDays(orgId, asOf) };
}
