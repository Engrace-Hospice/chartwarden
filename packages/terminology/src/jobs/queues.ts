// @chartwarden/terminology — terminology job queue catalog (M38-T10, spec §4.3).
//
// The canonical names + cadences of the §4.3 background jobs (BullMQ on Valkey). Pure data, no
// BullMQ import — the thin Worker/Queue construction lives in the app composition root
// (apps/backend/src/modules/38-terminology/jobs, GAP-108: one real Worker per queue) over the
// `packages/terminology-loader` orchestrators. The five `scheduled_*` jobs fetch (when egress is on /
// a credential is configured), register and enqueue a `load_version` for their system on the source's
// release cadence.

/** The nine §4.3 queue names. */
export const TERMINOLOGY_QUEUES = {
  /** On admin load OR per-source cadence: fetch, stage, diff, write concepts, supersede prior. */
  loadVersion: "terminology.load_version",
  /** On version `active` OR member edit: recompute `value_set_expansion` (2-min staleness window). */
  refreshExpansions: "terminology.refresh_expansions",
  /** On version `active` OR admin route: re-embed new/changed concepts (embeddings-worker). */
  refreshEmbeddings: "terminology.refresh_embeddings",
  /** On deprecations detected: build each tenant's remediation report + emit an M36 alert. */
  tenantDeprecationScan: "terminology.tenant_deprecation_scan",
  /** Annual (Sep dry-run, Oct activate): CMS ICD-10-CM. */
  scheduledIcd10cm: "terminology.scheduled_icd10cm",
  /** Twice yearly (Mar/Sep): UMLS SNOMED. */
  scheduledSnomed: "terminology.scheduled_snomed",
  /** Monthly: NLM RxNorm. */
  scheduledRxnorm: "terminology.scheduled_rxnorm",
  /** Per Regenstrief release (twice yearly): LOINC. */
  scheduledLoinc: "terminology.scheduled_loinc",
  /** Catch-all per source cadence (HCPCS quarterly, CARC/RARC ad hoc, CVX as published). */
  scheduledOther: "terminology.scheduled_other",
} as const;

/** A queue name from the catalog. */
export type TerminologyQueueName = (typeof TERMINOLOGY_QUEUES)[keyof typeof TERMINOLOGY_QUEUES];

/**
 * The repeat cadences for the scheduled loads, as cron expressions (UTC). The scheduler in the app
 * wiring registers these as BullMQ repeatable jobs; `loadVersion`/`refreshExpansions`/
 * `refreshEmbeddings`/`tenantDeprecationScan` are event-triggered, so they have no cron entry.
 */
export const TERMINOLOGY_JOB_SCHEDULES = {
  /** ICD-10-CM: dry-run Sep 15, activate Oct 1 (effective_from). Cron: 04:00 UTC Sep 15. */
  scheduledIcd10cm: "0 4 15 9 *",
  /** SNOMED: Mar 1 and Sep 1, 04:30 UTC. */
  scheduledSnomed: "30 4 1 3,9 *",
  /** RxNorm: monthly, the 5th at 05:00 UTC. */
  scheduledRxnorm: "0 5 5 * *",
  /** LOINC: Feb 1 and Aug 1, 05:30 UTC (twice-yearly Regenstrief release). */
  scheduledLoinc: "30 5 1 2,8 *",
  /**
   * ICD-10-CM ACTIVATION: Oct 1, 04:00 UTC — the `scheduled_icd10cm` queue's second repeatable job. The Sep 15 run
   * fetches and STAGES the next fiscal year (never activating); this run resumes that staged version (§4.3 "activate
   * Oct 1 effective_from").
   */
  scheduledIcd10cmActivate: "0 4 1 10 *",
  /** Catch-all (HCPCS quarterly / CARC / RARC ad hoc / CVX / NDC / revenue seed): monthly, the 1st at 06:00 UTC. */
  scheduledOther: "0 6 1 * *",
} as const;
