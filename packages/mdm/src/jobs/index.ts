// @wardenx/mdm — MDM background jobs (M40-T08, §4.3, §7.5).
// The §4.3 queue catalog (pure descriptors) + the headline NPPES nightly-delta processor and the
// pure §7.5 drift-detection engine. The remaining §4.3 workers land with their consumers.
export {
  MDM_QUEUES,
  MDM_JOB_SCHEDULES,
  M29_FALLBACK_THRESHOLD_HOURS,
  repointQueueName,
  type MdmQueueName,
} from "./queues";

export {
  detectNppesDrift,
  type NppesKnownPhysician,
  type NppesFreshRecord,
  type NppesDriftKind,
  type NppesDriftEvent,
} from "./drift";

export {
  runNppesNightlyDelta,
  type NppesNightlyPorts,
  type NppesNightlyResult,
  type NppesSyncLogEntry,
} from "./processors";
