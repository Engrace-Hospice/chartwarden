// apps/backend/src/modules/18-evv/jobs — M18's §4.8 workers (GAP-056): the late-check sweep, the aggregator
// submission prep / submitter / response poller, the GPS-spoof detector, and the `m18.dek-rotation`
// coordinate re-seal (consumer of `m34.tenant.dek_rotation_completed` + daily sweep).
export {
  type M18ActiveOrgListPort,
  type M18CronDeps,
  buildM18CronRunners,
  registerM18CronWorkers,
  runForEachActiveOrg,
  scheduleM18Jobs,
} from "./cron-workers";
export {
  type DekRotationDeps,
  type DekRotationResult,
  type EvvCoordsResealStore,
  EvvCoordsResealError,
  M18_DEK_ROTATION_CONSUMER,
  buildM18DekRotationConsumer,
  createDrizzleCoordsResealStore,
  needsReseal,
  resealOrgCoords,
} from "./dek-rotation";
export {
  type LateCheckSweepDeps,
  type LateCheckSweepResult,
  runLateCheckSweepForOrg,
} from "./late-check-sweep";
export {
  type EvvAggregatorDeps,
  type EvvAggregatorRegistryPort,
  type EvvSubmissionFactsPort,
  EVV_AGGREGATOR_STATES_ENV,
  EvvAggregatorPortUnboundError,
  createUnboundAggregatorCredentialStore,
  parseEvvAggregatorStateConfigs,
} from "./ports";
export { M18_CRON_QUEUES, M18_CRON_SCHEDULES, M18_CRON_QUEUE_PARAMS } from "./queues";
export {
  type M18SubmissionPrepConsumerDeps,
  type SubmissionPrepOutcome,
  M18_SUBMISSION_PREP_CONSUMER,
  buildM18SubmissionPrepConsumer,
  prepareAggregatorSubmission,
} from "./submission-prep";
export {
  type AggregatorTickResult,
  type AggregatorWorkerDeps,
  runAggregatorPollerForOrg,
  runAggregatorSubmitterForOrg,
} from "./submission-worker";
export {
  type SpoofDetectOutcome,
  type SpoofVerdict,
  M18_SPOOF_DETECTOR_CONSUMER,
  buildM18SpoofDetectorConsumer,
  detectSpoofForEvent,
  scoreSpoofSignals,
} from "./spoof-detector";
export { buildEvvAggregatorDeps, createEvvSubmissionFactsPort } from "./wiring";
