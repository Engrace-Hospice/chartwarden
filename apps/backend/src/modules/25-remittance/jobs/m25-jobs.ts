// apps/backend/src/modules/25-remittance/jobs/m25-jobs.ts — M25 (§2.4 / §4.8) the nightly cron handlers,
// PURE over injected store ports (the Drizzle + BullMQ binding lands at boot — module-only here, the M23
// conservative worker posture). Two crons:
//   - denial-aging   : recompute denial_case.aging_bucket_days for every open case; emit the 30-day / 90-day
//                      threshold-cross alerts; auto-open an appeal draft on the 90-day stale case (§2.4).
//   - appeal-deadline: for every appeal in a non-terminal state, emit the T-30/14/7/1 deadline alert at its
//                      boundary (the hard T-0 block is the ABAC predicate, not a cron) (D6).
import {
  type AgingBucketLabel,
  agingBucketLabel,
  agingDays,
  crossedAgingAlertThreshold,
  crossedStaleAppealThreshold,
  deadlineAlertBoundary,
} from "../domain";

/** An open denial case the aging cron rebuckets. */
export interface AgingCaseRow {
  readonly id: string;
  readonly openedAt: string;
  readonly currentBucketDays: number;
  readonly state: string;
}

/** The store the aging cron reads/writes (org-scoped at the call site). */
export interface DenialAgingStore {
  openCases(): Promise<AgingCaseRow[]>;
  setAgingBucketDays(denialCaseId: string, days: number): Promise<void>;
}

/** An M36 alert emission the cron forwards (PHI-free). */
export interface AlertEmission {
  readonly kind: string;
  readonly denialCaseId?: string;
  readonly appealCaseId?: string;
  readonly detail: Record<string, unknown>;
}

export interface DenialAgingResult {
  readonly rebucketed: number;
  readonly alerts: AlertEmission[];
}

/** Recompute aging buckets + collect the threshold-cross alerts for one nightly tick. */
export async function runDenialAging(
  store: DenialAgingStore,
  now: Date,
): Promise<DenialAgingResult> {
  const cases = await store.openCases();
  const alerts: AlertEmission[] = [];
  let rebucketed = 0;
  for (const c of cases) {
    const days = agingDays(new Date(c.openedAt), now);
    if (days !== c.currentBucketDays) {
      await store.setAgingBucketDays(c.id, days);
      rebucketed += 1;
    }
    const label: AgingBucketLabel = agingBucketLabel(days);
    // Fire the 30-day alert only on the tick that crosses it (yesterday's bucket was ≤30).
    if (crossedAgingAlertThreshold(days) && !crossedAgingAlertThreshold(c.currentBucketDays)) {
      alerts.push({
        kind: "denial.aging_threshold_breached",
        denialCaseId: c.id,
        detail: { days, label },
      });
    }
    if (crossedStaleAppealThreshold(days) && c.state !== "appealed") {
      alerts.push({
        kind: "denial.high_value",
        denialCaseId: c.id,
        detail: { days, autoAppealDraft: true },
      });
    }
  }
  return { rebucketed, alerts };
}

/** An appeal in a non-terminal state the deadline cron watches. */
export interface DeadlineAppealRow {
  readonly id: string;
  readonly tierDeadlineAt: string;
  readonly state: string;
}

export interface AppealDeadlineStore {
  watchableAppeals(): Promise<DeadlineAppealRow[]>;
}

export interface AppealDeadlineResult {
  readonly alerts: AlertEmission[];
}

/** Emit the T-30/14/7/1 deadline alert for each appeal at its current boundary. */
export async function runAppealDeadlineWatch(
  store: AppealDeadlineStore,
  now: Date,
): Promise<AppealDeadlineResult> {
  const appeals = await store.watchableAppeals();
  const alerts: AlertEmission[] = [];
  for (const a of appeals) {
    const boundary = deadlineAlertBoundary(new Date(a.tierDeadlineAt), now);
    if (boundary !== null) {
      alerts.push({
        kind: "appeal.deadline_approaching",
        appealCaseId: a.id,
        detail: { daysRemaining: boundary },
      });
    }
  }
  return { alerts };
}

/** An ADR still awaiting its response, as the deadline cron sees it. */
export interface DeadlineAdrRow {
  readonly id: string;
  readonly responseDueAt: string;
}

export interface AdrDeadlineStore {
  watchableAdrs(): Promise<DeadlineAdrRow[]>;
}

/** Emit the T-30/14/7/1 alert for each open ADR at its current boundary (same boundaries as appeals). */
export async function runAdrDeadlineWatch(
  store: AdrDeadlineStore,
  now: Date,
): Promise<AppealDeadlineResult> {
  const alerts: AlertEmission[] = [];
  for (const a of await store.watchableAdrs()) {
    const boundary = deadlineAlertBoundary(new Date(a.responseDueAt), now);
    if (boundary !== null) {
      alerts.push({
        kind: "adr.deadline_approaching",
        detail: { adrCaseId: a.id, daysRemaining: boundary },
      });
    }
  }
  return { alerts };
}
