// apps/backend/src/modules/27-cost-report/jobs — M27 background-jobs adapter barrel (§4.8).
//
// The thin, infra-touching BullMQ wiring that turns the @chartwarden/cost-report PURE domain (lifecycle reducer,
// allocation/ECR/validation, money/snapshot) into running `Worker`s + the cron-schedule `Queue`s. Unlike
// @chartwarden/quality, @chartwarden/cost-report ships NO processors/queue catalog (P1 = "no BullMQ"), so this folder
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
  // The §4.8 processor functions, exported for direct live-test invocation (no BullMQ transport precedent
  // exists in this codebase — see m27-cost-report-workflow-slice.live.test.ts). Each runs the SAME logic
  // `registerM27Workers` wraps in a `Worker`; calling it directly still exercises the real repos/pure-domain/
  // outbox emit inside a real `withOrgContext` tx, just without standing up an actual BullMQ consumer.
  runCostAllocationRecompute,
  runEcrGeneration,
  runTrialBalancePull,
  runValidationRun,
  scheduleM27Jobs,
  unboundWorkerPort,
} from "./m27-jobs";
// The LIVE ValidationContextBuilder (the §11.B context shaper) + its provider-entity resolver port.
export {
  type M27ValidationContextDeps,
  type ProviderEntityResolver,
  type PatientDaysSeam,
  type ClaimSettlementSeam,
  type DrugCostSeam,
  buildM27ValidationContext,
} from "./validation-context-builder";
// The LIVE AllocationInputBuilder (the §4320/§4330 cost-allocation-recompute input shaper).
export { buildM27AllocationInputs } from "./allocation-input-builder";
