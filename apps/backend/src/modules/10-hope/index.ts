// apps/backend/src/modules/10-hope — M10 (HOPE Engine) backend module surface.
//
// M10-T05 lands the three §2 / D10 owned seams (HopeTimepointProvider / HopeJ2051Provider /
// HopeSubmissionProvider) registered into the M1 registry via `registerHopeSeams` (driven from the
// composition root's wireModuleSeams()).
// M10-T06 adds the §4.1 route inventory + §4.6 perms (in @wardenx/auth) + §4.7 ABAC predicates + the §2.4
// outbox catalog + the §4.8 BullMQ job catalog & pure scans + the §4.9 M36 alert builders (in @wardenx/hope).
import type { DbClient } from "@wardenx/db";
import type { FastifyInstance } from "fastify";
import { registerHopeAbacPredicates as _registerM10Abac } from "./abac-predicates";
import { type HopeWriteOutboxPort, createDbHopeBackend } from "./hope-route-service-db";
import { registerHopeRoutes as _registerM10Routes } from "./routes/hope-routes";

/**
 * M10L — mount the M10 HOPE routes over the PRODUCTION Drizzle backend (RLS-scoped under `withOrgContext`).
 * One object satisfies BOTH the §4.1 HopeRouteService and the §4.7 HopeAbacResolver, so it registers as the
 * route service AND the ABAC resolver. Reads and the write lifecycle (record → sign → correct, SFV
 * completion, schedule skip, submission assemble/retry) are live over Drizzle; every state transition emits
 * its `m10.hope.*` event on the passed transactional-outbox publisher (the composition root binds M1's
 * catalog-validating publisher pinned to caller-module `m10`). Replaces the in-memory scaffold mount for M10.
 */
export function mountHopeRoutes(
  app: FastifyInstance,
  db: DbClient,
  outbox?: HopeWriteOutboxPort,
): void {
  const backend = createDbHopeBackend(db, outbox);
  _registerM10Abac({ resolver: backend });
  _registerM10Routes(app, { service: backend });
}

export { type HopeWriteOutboxPort, createDbHopeBackend } from "./hope-route-service-db";
export {
  type HopeOrgRollupSeed,
  type HopeOrgRollupStore,
  type HopeSeamDeps,
  type HopeSeamSeed,
  type HopeSeamStore,
  type J2051SeverityEntry,
  type J2051TriggerRow,
  type SfvTimelinessRow,
  type SubmissionPostureRow,
  type TimepointCompletionRow,
  createDrizzleHopeOrgRollupStore,
  createHopeJ2051Provider,
  createHopeOrgRollupProvider,
  createHopeSubmissionProvider,
  createHopeTimepointProvider,
  createInMemoryHopeOrgRollupStore,
  createInMemoryHopeSeamStore,
  getHopeJ2051Provider,
  getHopeOrgRollupProvider,
  getHopeSubmissionProvider,
  getHopeTimepointProvider,
  getLatestAssessmentProviderForHope,
  registerHopeSeams,
} from "./seams/index";
// M10-T06 — the §4.1 route inventory over an in-memory backend + the §4.7 ABAC predicates M10 owns
// (`hope.authorDisciplineAllowed` / `hope.sfvAuthorAllowed` / `hope.correctionAuthorAllowed`). The §4.6
// permission keys M10 contributes to M3 live in @wardenx/auth (M10_CONTRIBUTED_PERMISSIONS).
export {
  type HopeAbacDeps,
  type HopeAbacResolver,
  type HopeAssessmentAbacFacts,
  M10_ABAC_PREDICATES,
  buildHopeAbacPredicates,
  hopeDisciplinesOf,
  registerHopeAbacPredicates,
} from "./abac-predicates";
export { type HopeRouteDeps, registerHopeRoutes } from "./routes/hope-routes";
export {
  type CorrectTimepointArgs,
  type HopeAssessmentView,
  type HopeComplianceView,
  type HopeRouteSeed,
  type HopeRouteService,
  type HopeScheduleView,
  type HopeSfvView,
  type HopeSubmissionView,
  type RecordSfvArgs,
  type RecordTimepointArgs,
  type RecordedHopeEvent,
  createInMemoryHopeBackend,
} from "./routes/service";
// M10-T06 — the §2.4 outbox contract (the full `m10.hope.*` taxonomy; check-fitness-gaps.ts scans
// events-by-m10.ts for naming + ownership + declared consumers).
export { M10_OUTBOX_EVENTS } from "./events-by-m10";
// #48 — the LIVE `m6.admission.activated` / `m6.admission.discharged` → timepoint-schedule consumer and
// the write path it shares with the §4.1 route-20 admin regenerate. Nothing wrote `hope_timepoint_schedule`
// before these, so the whole CMS capture-window model sat on an empty table.
export {
  M10_ADMISSION_ACTIVATED_EVENT,
  M10_ADMISSION_DISCHARGED_EVENT,
  M10_SCHEDULING_CONSUMER_NAME,
  buildM10AdmissionSchedulingConsumer,
} from "./outbox-consumers/m6-admission-scheduling";
export {
  HOPE_SCHEDULE_TIME_ZONE,
  type SchedulingSiting,
  regenerateSchedulesForAdmission,
  schedulingSitingFor,
  writeSchedules,
} from "./scheduling/schedule-writer";
// M10-T06 — the §4.8 BullMQ queue catalog + the pure window / SFV watchdog + alert-dispatch scans.
export {
  type HopeScheduleSnapshot,
  type HopeScheduleTransition,
  type HopeWindowWatchdogPlan,
  type PlannedHopeAlert,
  type PlannedHopeEvent,
  type SfvAlertCandidate,
  type SfvWatchdogPlan,
  type SfvWatchdogSnapshot,
  type SfvWatchdogTransition,
  type TimepointAlertCandidate,
  M10_DLQ,
  M10_JOB_PARAMS,
  M10_JOB_SCHEDULES,
  M10_QUEUES,
  jobIdempotencyKey,
  planHopeAlertDispatch,
  planHopeWindowWatchdog,
  planSfvWatchdog,
} from "./jobs/index";
// TASK-040D — the LIVE `hope-window-watchdog` / `sfv-watchdog` BullMQ Worker/Queue construction (the
// M25 precedent) + the platform-tenancy registration their active-org fan-out needs.
export {
  type ActiveOrgListPort as M10ActiveOrgListPort,
  type HopeOutboxPublishPort,
  type M10WorkerDeps,
  buildM10WorkerDeps,
  registerM10CronWorkers,
  runHopeWindowWatchdogCron,
  runSfvWatchdogCron,
  scheduleM10Jobs,
} from "./jobs/cron-workers";
export { M10_PLATFORM_JOB_ID, wireM10Tenancy } from "./wiring";
// M10-T07 — the §4.10 iQIES submission worker loop: the pure assemble / submit-readiness / transmit /
// reconcile / correction-RFA processors over the `hope:submission` queue (the adapter call + MinIO put +
// SHA-256 are the boot-bound driver's only IO; the @wardenx/iqies-client adapter is the D6 boundary).
export {
  type AssemblableAssessment,
  type AssembleSubmissionsPlan,
  type CorrectionContext,
  type CorrectionRfaPlan,
  type PlannedSubmission,
  type PlannedSubmissionEvent,
  type PlannedSubmissionFinding,
  type PlannedSubmissionItem,
  type ReconcileItemOutcome,
  type ReconcileItemTransition,
  type ReconcilePlan,
  type SubmissionItemValidation,
  type SubmitReadiness,
  type TransmitResultPlan,
  buildSubmissionEnvelope,
  decideSubmitReadiness,
  planAssembleSubmissions,
  planCorrectionRfa,
  planReconcile,
  planTransmitResult,
  submissionPeriodFor,
} from "./jobs/submission";
// F-058 (#150) — the Drizzle read/write half of §4.10 stage 1. `hope_submission_item` had no writer
// anywhere in the repo and `planAssembleSubmissions` had no production caller; both now run behind
// `assembleSubmission` on the route service.
export {
  type AssemblableScan,
  type PersistedSubmission,
  assemblableAssessmentsForOrg,
  persistAssembledSubmission,
  queuedSubmissionCountForOrg,
} from "./jobs/assemble-store";
// M10-T08 — the `hope_record` data eraser (§8.4). registerHopeErasers stands the REAL eraser over the
// Phase-0 deny-stub; invoked from the composition root's wireModuleErasers() before validateErasers(). The
// pure retention/partition core (earliestErasableInstant / isHopeErasureBlocked / eraseHopeRecord) is unit
// tested across all four §9.1 paths (partition-drop, mixed-partition row-delete, retention-block, override).
export {
  type HopeEraseCounts,
  type HopeEraseOptions,
  type HopeEraseStore,
  type HopeEraserDeps,
  type InMemoryHopeEraseSeed,
  type SubmittedAssessmentRef,
  HopeRetentionBlockedError,
  addYears,
  createDrizzleHopeEraseStore,
  createHopeEraser,
  createInMemoryHopeEraseStore,
  earliestErasableInstant,
  eraseHopeRecord,
  isHopeErasureBlocked,
  registerHopeErasers,
} from "./erasers/hope-eraser";
