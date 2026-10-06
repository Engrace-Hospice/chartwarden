// apps/backend/src/modules/21-supplies/jobs/queues.ts — the M21 §4.6 queue + cron catalog (GAP-062).
//
// Only the three CRONS the spec's §4.6 table schedules are modelled here. `m21.invoice_reconciliation`
// ("when M27 forward seam is live") and the two event-driven queues are not crons and have no runner yet.

/** The platform job id the active-org enumerator enters `withPlatformContext` under (must be allowlisted). */
export const M21_PLATFORM_JOB_ID = "m21-supplies-cron";

export const M21_QUEUES = {
  /** §4.6 / D5 — par-stock sweep. */
  parMonitor: "m21.par_monitor",
  /** §4.6 / §2.6 — the unreturned-kit sweep (30d overdue flip, 90d escalation re-emit). */
  unreturnedKitMonitor: "m21.unreturned_kit_monitor",
  /** §2.10 — vendor-confirmation / delivery lateness advisories and the 72h receipt auto-confirm. */
  supplyRequestMonitor: "m21.supply_request_monitor",
} as const;

/** The local wall-clock hour at which a Location's par sweep runs (§4.6: "04:00 in each Location TZ"). */
export const PAR_MONITOR_LOCAL_HOUR = 4;

export const M21_JOB_SCHEDULES = {
  /** Hourly (UTC); the worker runs a Location only when its OWN local hour is {@link PAR_MONITOR_LOCAL_HOUR}. */
  parMonitor: "10 * * * *",
  /** §4.6 — daily 06:00 UTC. */
  unreturnedKitMonitor: "0 6 * * *",
  /** Every 4 hours: bounds the 72h auto-confirm lag to 4h while keeping the advisory re-emits (M36 dedupes,
   *  §7.5) to six a day. */
  supplyRequestMonitor: "20 */4 * * *",
} as const;
