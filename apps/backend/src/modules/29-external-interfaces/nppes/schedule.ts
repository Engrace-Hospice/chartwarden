// apps/backend/src/modules/29-external-interfaces/nppes — the NPPES nightly-sync schedule descriptor
// (M29-T07, §5 / D11). PURE data. The M29-T08 worker binds this to the BullMQ scheduler; keeping it as a
// leaf constant means the cron pattern, the platform-singleton concurrency invariant, and the queue name are
// all assertable without importing bullmq into the module cores.
import type { NppesSyncKind, NppesSyncTrigger } from "@wardenx/types";

export interface NppesSyncSchedule {
  readonly queueName: string;
  /** Crontab pattern (02:30 UTC nightly — after the ~23:00 UTC NPPES dissemination has propagated to the API). */
  readonly cronPattern: string;
  readonly timezone: string;
  /** Platform-wide singleton: two concurrent runs would double the API request budget (§ notes 8). */
  readonly concurrency: 1;
  /** The nightly cron run's kind + trigger (§3.2 enums). A manual run is `manual` / `platform_admin`. */
  readonly nightlyKind: NppesSyncKind;
  readonly nightlyTrigger: NppesSyncTrigger;
}

export const NPPES_SYNC_SCHEDULE: NppesSyncSchedule = {
  queueName: "nppes-sync-platform",
  cronPattern: "30 2 * * *",
  timezone: "UTC",
  concurrency: 1,
  nightlyKind: "daily_incremental",
  nightlyTrigger: "platform_cron",
};
