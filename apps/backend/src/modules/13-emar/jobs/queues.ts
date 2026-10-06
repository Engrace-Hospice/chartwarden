// apps/backend/src/modules/13-emar/jobs/queues.ts — M13 §4.8 BullMQ queue catalog for the six crons this
// module owns (GAP-038 extend-schedule / reconciliation-due-warning / kit-return-overdue /
// purge-offline-queue, GAP-039 missed-dose-sweep, GAP-040 prn-reassessment-overdue). Pure data; the worker construction is in
// `./cron-workers.ts`.

export const M13_CRON_QUEUES = {
  /** Daily — extend every active scheduled order's `scheduled_dose` window (§2.3 mode 2). */
  extendSchedule: "m13.extend-schedule",
  /** Every 15 minutes — detect scheduled doses past `due_at + grace` with no administration (§2.5 D4). */
  missedDoseSweep: "m13.missed-dose-sweep",
  /** Hourly — 24h-before-deadline warning + overdue for open reconciliation worksheets (§2.8). */
  reconciliationDueWarning: "m13.reconciliation-due-warning",
  /** Daily — comfort kits unreturned 30 days after `return_required_at` (§2.7). */
  kitReturnOverdue: "m13.kit-return-overdue",
  /** Every 15 minutes — PRN administrations whose reassessment deadline passed with no scale captured (§2.4). */
  prnReassessmentOverdue: "m13.prn-reassessment-overdue",
  /** Nightly — purge synced `administration_offline_queue` rows 30 days post-sync (§3 retention). */
  purgeOfflineQueue: "m13.purge-offline-queue",
} as const;

export type M13CronQueueName = (typeof M13_CRON_QUEUES)[keyof typeof M13_CRON_QUEUES];

/** Minutes in each sweep tick — the window width the deadline sweeps de-duplicate on (see `./windows.ts`). */
export const M13_MISSED_DOSE_SWEEP_PERIOD_MINUTES = 15;
export const M13_PRN_OVERDUE_PERIOD_MINUTES = 15;
export const M13_RECONCILIATION_PERIOD_MINUTES = 60;

export const M13_CRON_SCHEDULES = {
  // Spec says tenant-local midnight + 15; the extension is idempotent (unique (org, order, due_at)) and
  // anchors its window on each ORDER's local calendar day, so one fixed UTC tick is correct for every tz.
  extendSchedule: "15 4 * * *",
  missedDoseSweep: "*/15 * * * *",
  reconciliationDueWarning: "0 * * * *",
  kitReturnOverdue: "30 5 * * *",
  prnReassessmentOverdue: "*/15 * * * *",
  purgeOfflineQueue: "45 6 * * *",
} as const;

/** Retry policy per the §4.8 catalog (`attempts` + a fixed backoff of the first step). */
export const M13_CRON_QUEUE_PARAMS = {
  extendSchedule: { attempts: 5, backoffMs: 60_000, concurrency: 1, priority: 5 },
  missedDoseSweep: { attempts: 3, backoffMs: 5_000, concurrency: 1, priority: 3 },
  reconciliationDueWarning: { attempts: 3, backoffMs: 5_000, concurrency: 1, priority: 5 },
  kitReturnOverdue: { attempts: 3, backoffMs: 5_000, concurrency: 1, priority: 7 },
  prnReassessmentOverdue: { attempts: 3, backoffMs: 5_000, concurrency: 1, priority: 5 },
  // §4.8: 5m/30m backoff, 3 attempts (a nightly housekeeping job — lowest priority).
  purgeOfflineQueue: { attempts: 3, backoffMs: 300_000, concurrency: 1, priority: 9 },
} as const;
