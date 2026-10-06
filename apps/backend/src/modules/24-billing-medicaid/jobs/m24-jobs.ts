// apps/backend/src/modules/24-billing-medicaid/jobs/m24-jobs.ts — the M24 §4.9 pure cron handlers over
// injected stores (no bullmq, no Drizzle import — deterministic + unit-testable). Each cron fans out per
// active org; the store does the org-scoped read/write under withOrgContext at the call site. The real
// eligibility + rb_day stores live in rb-day-sweep.ts (GAP-071); the ack pull / state-channel health crons
// have their own files.

export interface StaleEligibilityFinding {
  readonly patientId: string;
  /** ISO instant of the patient's latest (now stale) eligibility check. */
  readonly lastCheckedAt: string;
  /** The provider entity of the patient's latest check (nullable on the row, §3.3) — the biller audience scope. */
  readonly providerEntityId: string | null;
}
export interface EligibilityWatchdogStore {
  staleEligibilityCount(orgId: string, asOf: string): Promise<number>;
  /** Patients whose latest check is past `stale_at` (bounded per tick by the store). */
  staleEligibilityFindings(
    orgId: string,
    asOf: string,
  ): Promise<readonly StaleEligibilityFinding[]>;
}

/** M36 alert dispatch for the watchdog (best-effort; the composition root adapts it to the AlertEmitter seam). */
export interface EligibilityAlertPort {
  dispatch(input: {
    readonly eventType: string;
    readonly organizationId: string;
    readonly severity: "warn";
    readonly correlationId: string;
    readonly payload: Record<string, unknown>;
  }): Promise<unknown>;
}

/**
 * The spec's §4.10 M24_ALERTS key (severity warn, audience biller_for_pe, payload {patientId,lastCheckedAt}).
 * `biller_for_pe` = the billers (and billing managers) assigned to the patient's provider entity: the payload
 * carries `providerEntityId` and the seeded M36 rule resolves `role_set` narrowed to that PE, falling back to
 * the org-wide billing_manager only when nobody is assigned to it (or the check has no PE).
 */
export const M24_ELIGIBILITY_STALE_ALERT = "medicaid.eligibility.stale_at_assembly";
export interface RbDaySweepStore {
  sweepPendingDays(orgId: string, asOf: string): Promise<number>;
}

/**
 * Daily: find patients whose latest eligibility check is past its 30-day staleAt and raise one M36
 * `medicaid.eligibility.stale_at_assembly` alert per patient (only when there are findings). The correlation id
 * is keyed on (org, patient, lastCheckedAt), so the emitter's `(org, correlationId)` dedupe means a standing
 * condition pages ONCE, not every tick, and re-pages only after a fresh check goes stale again. Alerting is
 * best-effort: a failed dispatch is logged and never fails the tick.
 */
export async function runEligibilityStaleWatchdog(
  store: EligibilityWatchdogStore,
  orgId: string,
  asOf: string,
  alerts?: EligibilityAlertPort,
  log?: { error(err: unknown, msg: string): void },
): Promise<{ stale: number; alerted: number }> {
  const findings = await store.staleEligibilityFindings(orgId, asOf);
  if (!alerts) return { stale: findings.length, alerted: 0 };
  let alerted = 0;
  for (const f of findings) {
    try {
      await alerts.dispatch({
        eventType: M24_ELIGIBILITY_STALE_ALERT,
        organizationId: orgId,
        severity: "warn",
        correlationId: `m24-eligibility-stale:${orgId}:${f.patientId}:${f.lastCheckedAt}`,
        payload: {
          patientId: f.patientId,
          lastCheckedAt: f.lastCheckedAt,
          ...(f.providerEntityId === null ? {} : { providerEntityId: f.providerEntityId }),
        },
      });
      alerted += 1;
    } catch (err) {
      log?.error(err, `M24 eligibility-stale alert dispatch failed for org ${orgId}`);
    }
  }
  return { stale: findings.length, alerted };
}

/** Daily: materialize pending rb_days up to the as-of date from the M6 LOC snapshot (sweep). */
export async function runRbDayDailySweep(
  store: RbDaySweepStore,
  orgId: string,
  asOf: string,
): Promise<{ swept: number }> {
  return { swept: await store.sweepPendingDays(orgId, asOf) };
}
