// apps/backend/src/modules/10-hope — M10 (HOPE Engine) backend module surface.
//
// M10-T05 lands the three §2 / D10 owned seams (HopeTimepointProvider / HopeJ2051Provider /
// HopeSubmissionProvider) registered into the M1 registry via `registerHopeSeams` (driven from the
// composition root's wireModuleSeams()).
// M10-T06 adds the §4.1 route inventory + §4.6 perms (in @wardenx/auth) + §4.7 ABAC predicates + the §2.4
// outbox catalog + the §4.8 BullMQ job catalog & pure scans + the §4.9 M36 alert builders (in @wardenx/hope).
export {
  type HopeSeamDeps,
  type HopeSeamSeed,
  type HopeSeamStore,
  createHopeJ2051Provider,
  createHopeSubmissionProvider,
  createHopeTimepointProvider,
  createInMemoryHopeSeamStore,
  getHopeJ2051Provider,
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
