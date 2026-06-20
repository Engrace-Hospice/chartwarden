// @wardenx/mdm — MDM job queue catalog (M40-T08, spec §4.3).
//
// The canonical names + cadences of the §4.3 background jobs (BullMQ on Valkey). Pure data, no
// BullMQ import — the thin Worker/Queue construction lives in the app composition root once a Valkey
// connection + the production adapters (the NPPES fetch adapter, the `mdm_canonical_writer` Drizzle
// writer, the M36 alert emitter) exist. M40 owns the policy + these pure descriptors; the same
// M1-owns-mechanism / module-owns-policy split as the M38 terminology jobs.

/** The eight §4.3 queue names. The `repoint_<consumer>` family is templated per consumer table. */
export const MDM_QUEUES = {
  /** Scheduled 02:00 local, FALLBACK-ONLY: runs only when M29's last sync completed > 25h ago. */
  nppesNightlyDelta: "mdm.nppes_nightly_delta",
  /** Scheduled Sun 03:00: full sweep over all canonical physician NPIs; reconciles drift. */
  nppesWeeklyFull: "mdm.nppes_weekly_full",
  /** Scheduled daily: trigram + Levenshtein candidate pairs → emit `merge_request` rows. */
  fuzzyDedupScan: "mdm.fuzzy_dedup_scan",
  /** On merge approval: flip duplicate → merged; enqueue `mdm.repoint_*` per consumer table. */
  executeMerge: "mdm.execute_merge",
  /** Scheduled daily: 90/30/0-day BAA expiration alerts via Module 36. */
  baaExpirationScan: "mdm.baa_expiration_scan",
  /** Scheduled daily: physician/credential license expiration alerts. */
  licenseExpirationScan: "mdm.license_expiration_scan",
  /** Scheduled weekly: provisional rows pending > 14 days → escalate to platform-ops. */
  provisionalAgingScan: "mdm.provisional_aging_scan",
} as const;

/** A queue name from the catalog. */
export type MdmQueueName = (typeof MDM_QUEUES)[keyof typeof MDM_QUEUES];

/** The per-consumer re-pointing queue name for a consumer table (§4.3 `mdm.repoint_<consumer>`). */
export function repointQueueName(consumerTable: string): string {
  return `mdm.repoint_${consumerTable}`;
}

/**
 * The repeat cadences for the scheduled jobs, as cron expressions. The scheduler in the app wiring
 * registers these as BullMQ repeatable jobs; `executeMerge` / `repoint_*` are event-triggered, so
 * they have no cron entry. The nightly delta uses 02:00 (the §4.3 local time; the app binds TZ).
 */
export const MDM_JOB_SCHEDULES = {
  /** NPPES nightly delta: 02:00. */
  nppesNightlyDelta: "0 2 * * *",
  /** NPPES weekly full: Sunday 03:00. */
  nppesWeeklyFull: "0 3 * * 0",
  /** Fuzzy dedup scan: daily 04:00. */
  fuzzyDedupScan: "0 4 * * *",
  /** BAA expiration scan: daily 06:00. */
  baaExpirationScan: "0 6 * * *",
  /** License expiration scan: daily 06:30. */
  licenseExpirationScan: "30 6 * * *",
  /** Provisional aging scan: Monday 07:00. */
  provisionalAgingScan: "0 7 * * 1",
} as const;

/** The §4.3 "fallback-only" threshold: the nightly delta fires only when M29's last sync is older
 *  than this. M29's platform sync (T-29.09) is the authoritative path; M40 is the fallback. */
export const M29_FALLBACK_THRESHOLD_HOURS = 25;
