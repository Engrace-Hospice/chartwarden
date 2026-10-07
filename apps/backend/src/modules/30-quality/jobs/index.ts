// apps/backend/src/modules/30-quality/jobs — M30 background-jobs adapter barrel (Phase 2C, §4.8).
//
// The thin, infra-touching BullMQ wiring that turns the @wardenx/quality PURE processors (the four §4.8
// work-queue workers + the four crons) into running `Worker`s + the cron-schedule `Queue`s. Unlike M33,
// the §4.8 PURE catalog (queue names / params / schedules / DLQ / idempotency keys / processors) already
// lives in @wardenx/quality (the `workers/*` subtree); this folder holds ONLY the live `Worker`/`Queue`
// construction + the port-binding (`m30-jobs.ts`). The composition root imports `registerM30Workers` /
// `registerM30CronWorkers` / `scheduleM30Jobs` from here at boot. Nothing runs at import.
export {
  type M30CronPortBundles,
  type M30CronQueueName,
  type M30WorkerDeps,
  type M30WorkerPortBundles,
  M30_CRON_QUEUES,
  buildM30CronPorts,
  buildM30WorkerDeps,
  buildM30WorkerPorts,
  registerM30CronWorkers,
  registerM30Workers,
  scheduleM30Jobs,
} from "./m30-jobs";
// GAP-155 - the CAP-overdue producer cron.
export {
  M30_CAP_OVERDUE_QUEUE,
  registerM30CapOverdueWorker,
  scheduleM30CapOverdueJob,
} from "./cap-overdue-scan";
