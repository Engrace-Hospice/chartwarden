// apps/backend/src/modules/26-cap/jobs/m26-jobs.ts — the PURE M26 §4.8 cron handlers (importable without
// bullmq; the unit tests exercise them directly). Each fans out per active org under withOrgContext (bound
// by cron-workers.ts): the nightly projection recompute, the cap-year auto-close past the grace window, and
// the stale-PS&R-reconciliation watchdog. No Date.now / Valkey / Drizzle import here — the caller injects the
// store + the as-of clock.

export interface NightlyProjectionStore {
  listOpenPeriods(orgId: string): Promise<readonly { id: string }[]>;
  recompute(orgId: string, periodId: string): Promise<void>;
}

/** Nightly projection recompute for every open/active/reopened period in an org. Returns the count recomputed. */
export async function runNightlyProjection(
  store: NightlyProjectionStore,
  orgId: string,
): Promise<{ recomputed: number }> {
  const periods = await store.listOpenPeriods(orgId);
  for (const p of periods) await store.recompute(orgId, p.id);
  return { recomputed: periods.length };
}

export interface CapYearCloseStore {
  /** Active periods whose ends_on + grace_window_days < asOf (past the grace window). */
  listClosablePeriods(orgId: string, asOf: string): Promise<readonly { id: string }[]>;
  close(orgId: string, periodId: string): Promise<void>;
}

/** Auto-close every active period past Sep 30 + grace window (D8). Returns the count closed. */
export async function runCapYearClose(
  store: CapYearCloseStore,
  orgId: string,
  asOf: string,
): Promise<{ closed: number }> {
  const periods = await store.listClosablePeriods(orgId, asOf);
  for (const p of periods) await store.close(orgId, p.id);
  return { closed: periods.length };
}

export interface PsrWatchdogStore {
  /** Count of open/investigating reconciliation rows older than `staleDays` as of `asOf`. */
  staleReconciliationCount(orgId: string, asOf: string, staleDays: number): Promise<number>;
}

/** Surface stale PS&R reconciliations (> 90 days open). Returns the stale count (the worker alerts on > 0). */
export async function runPsrVarianceWatchdog(
  store: PsrWatchdogStore,
  orgId: string,
  asOf: string,
  staleDays = 90,
): Promise<{ stale: number }> {
  return { stale: await store.staleReconciliationCount(orgId, asOf, staleDays) };
}
