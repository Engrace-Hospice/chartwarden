// apps/backend/src/modules/31-portal/jobs/queues.ts — M31's BullMQ queue/cron catalog (F-222/#248). Pure
// constants (no bullmq import).
//
// MECHANISM DECISION (M31 spec is internally inconsistent — §4.8 names a DAILY `m31.post-discharge-grace.cron`
// sweep, §7.6 a per-event 30-day DELAYED job that a re-admission CANCELS): the DAILY SWEEP over M6's CURRENT
// discharge state wins. A re-admitted patient simply stops being a candidate (an open admission exists again),
// so there is no cancel logic, no per-event job to lose to a Redis flush, and a crashed/rebuilt queue just
// re-discovers every due grant on its next tick — the `M29_OUTBOUND_CRON_QUEUES` poll-sweep precedent.
export const M31_CRON_QUEUES = {
  postDischargeGrace: "m31-post-discharge-grace",
} as const;

/** Daily 02:30 UTC — spec §4.8. */
export const M31_JOB_SCHEDULES = {
  postDischargeGrace: "30 2 * * *",
} as const;

export const M31_QUEUE_PARAMS = {
  postDischargeGrace: { concurrency: 1 },
} as const;

/** Spec §3.3 / §2.3: "configurable per tenant; FLOOR is 30 days". The sweep never uses fewer. */
export const M31_POST_DISCHARGE_GRACE_FLOOR_DAYS = 30;

/** Max PATIENTS whose care-time grants one org's tick may revoke. Bounds a first run over a large discharged
 *  backlog (the deployment-day case): the remainder drains on following ticks, oldest-first by patient id. */
export const M31_GRACE_SWEEP_MAX_REVOCATIONS_PER_ORG_PER_RUN = 100;

/** Distinct patients with active care-time grants read per page (well under the M6 seam's 500 cap). */
export const M31_GRACE_SWEEP_SCAN_PAGE_SIZE = 200;

/** Hard ceiling on patients SCANNED per org per run (read-only; bounds a pathological grant table). */
export const M31_GRACE_SWEEP_MAX_SCAN_PER_ORG_PER_RUN = 5000;

/** Not a real membership row — the system actor (`revoked_by_membership_id` is nullable). */
export const M31_WORKER_SYSTEM_USER_ID = "";
