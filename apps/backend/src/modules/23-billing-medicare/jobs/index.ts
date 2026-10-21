// apps/backend/src/modules/23-billing-medicare/jobs — M23 background-jobs adapter barrel (§4.8).
//
// The thin, infra-touching BullMQ wiring that turns the @chartwarden/billing PURE domain (the claim/noe/notr
// lifecycle reducers, the validation rule registry, the HIPPS/SIA/sequestration/TOB calculators, the
// control-number deriver) into running `Worker`s + the cron-schedule `Queue`s. @chartwarden/billing ships NO
// BullMQ catalog, so this folder holds BOTH the §4.8 queue catalog (`queues.ts`) AND the live `Worker`/`Queue`
// construction + processor logic (`m23-jobs.ts`). The composition root imports `registerM23Workers` /
// `registerM23CronWorkers` / `scheduleM23Jobs` / `buildM23WorkerDeps` from here at boot. Nothing runs at import.
export {
  M23_CRON_QUEUES,
  type M23CronQueueName,
  M23_IDEMPOTENCY_KEYS,
  M23_JOB_SCHEDULES,
  type M23QueueName,
  type M23QueueParam,
  M23_QUEUE_PARAMS,
  M23_QUEUES,
} from "./queues";
export {
  migrateLegacyValidationRunJobs,
  sweepLegacyValidationRunQueue,
} from "./legacy-validation-queue";
export {
  type ActiveOrgListPort,
  type ClaimSubmitJob,
  type ClaimSubmitRetryJob,
  type ClaimValidationRunnerPort,
  type EligibilityRefreshJob,
  type HetsEligibilityPort,
  type HetsEligibilityResult,
  type HetsHospiceHistory,
  eligibilityParsedPayload,
  type JobEnqueuePort,
  type M23WorkerDeps,
  type MacJurisdictionListPort,
  type MacPortalPort,
  type NoeSubmitJob,
  type NoticeWindowPort,
  type NotrSubmitJob,
  type Parsed277ca,
  type Parsed999,
  type RevalidateConsumerJob,
  type RevalidationTargetResolverPort,
  type ValidationRunJob,
  type WorkerAlertPort,
  type WorkerOutboxInput,
  type WorkerOutboxPort,
  type X12ClientPort,
  buildM23WorkerDeps,
  buildM23SubmissionQueuePort,
  buildM23RevalidateEnqueuePort,
  registerM23CronWorkers,
  registerM23DomainWorkers,
  registerM23PortalHealthWorker,
  registerM23Workers,
  registerM23LaunchWorkers,
  registerM23WatchCronWorkers,
  scheduleM23Jobs,
  scheduleM23LaunchJobs,
  scheduleM23WatchJobs,
  unboundWorkerPort,
} from "./m23-jobs";
export {
  buildClaimValidationRunner,
  buildM23ValidationRunner,
  buildM23WorkQueueEnqueuePort,
  buildNoticeWindowPort,
  m23WorkerActor,
} from "./m23-worker-ports";
export {
  type MacJurisdictionOrgSource,
  type OrgMacJurisdictionReader,
  buildDrizzleOrgMacJurisdictionReader,
  buildMacJurisdictionLister,
} from "./mac-jurisdictions";
export {
  ELIGIBILITY_FRESHNESS_DAYS,
  type HetsEligibilityPortDeps,
  type HetsProviderPort,
  type M23HetsConfig,
  buildHetsEligibilityPort,
  createM23HetsTransport,
  m23HetsConfigFromEnv,
} from "./hets-eligibility";
