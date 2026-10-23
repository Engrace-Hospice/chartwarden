// apps/backend/src/modules/25-remittance/jobs — M25 §4.8 job surface barrel. The PURE cron handlers
// (m25-jobs.ts), the §4.8 BullMQ cron-queue catalog (queues.ts), and the live worker construction
// (cron-workers.ts). The composition root imports the build/register/schedule trio; the pure handlers stay
// importable without bullmq (the unit tests exercise them directly).
export * from "./m25-jobs";
export * from "./qic-overdue";
export * from "./submission-proof-watch";
export * from "./recorded-deadline-watch";
export * from "./audit-no-deadline-watch";
export * from "./queues";
export {
  type M25WorkerDeps,
  type WorkerAlertPort,
  type ActiveOrgListPort,
  buildM25WorkerDeps,
  registerM25CronWorkers,
  runAppealDeadlineCron,
  runDenialAgingCron,
  scheduleM25Jobs,
} from "./cron-workers";
