// apps/backend/src/modules/27-cost-report/jobs — M27 background-jobs adapter barrel (§4.8).
//
// The thin, infra-touching BullMQ wiring that turns the @wardenx/cost-report PURE domain (lifecycle reducer,
// allocation/ECR/validation, money/snapshot) into running `Worker`s + the cron-schedule `Queue`s. Unlike
// @wardenx/quality, @wardenx/cost-report ships NO processors/queue catalog (P1 = "no BullMQ"), so this folder
// holds BOTH the §4.8 queue catalog (`queues.ts`) AND the live `Worker`/`Queue` construction + processor logic
// (`m27-jobs.ts`). The composition root imports `registerM27Workers` / `registerM27CronWorkers` /
// `scheduleM27Jobs` from here at boot. Nothing runs at import.
export {
  M27_CRON_QUEUES,
  type M27CronQueueName,
  M27_IDEMPOTENCY_KEYS,
  M27_JOB_SCHEDULES,
  type M27QueueName,
  type M27QueueParam,
  M27_QUEUE_PARAMS,
  M27_QUEUES,
} from "./queues";
export {
  type ActiveOrgListPort,
  type AllocationInputBuilder,
  type CostAllocationRecomputeJob,
  type EcrGenerationJob,
  type M27WorkerDeps,
  type SnapshotBuilderJob,
  type StatisticsRefreshJob,
  type StatisticsSeams,
  type TrialBalancePullJob,
  type TrialBalancePullSeam,
  type ValidationContextBuilder,
  type ValidationRunJob,
  type WageDataPullJob,
  type WageDataPullSeam,
  type WorkerAlertPort,
  type WorkerDekPort,
  type WorkerOutboxPort,
  buildM27WorkerDeps,
  deadlineTierFor,
  registerM27CronWorkers,
  registerM27Workers,
  scheduleM27Jobs,
  unboundWorkerPort,
} from "./m27-jobs";
