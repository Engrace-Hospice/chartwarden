// apps/backend/src/modules/37-ipu — M37 Inpatient Unit (IPU) Management backend module entrypoint.
//
// The pure §2 domain kernels live in @wardenx/inpatient (T03–T10); this module is the HTTP/adapter surface.
// As of T11b it exposes the §4.7 ABAC predicate registration; the §4.1 routes + Drizzle route service +
// §4.4 outbox catalog + §7.7 eraser + SeamRegistry registration land across the remaining T11 slices.
export {
  M37_REGISTERED_ABAC_PREDICATES,
  type M37RegisteredAbacPredicate,
  buildM37AbacPredicates,
  registerM37AbacPredicates,
} from "./abac/predicates";

// §4.6 — the permission keys M37 contributes to M3 (declared in @wardenx/auth; re-exported for the route
// layer's requirePermission handlers).
export { M37_CONTRIBUTED_PERMISSIONS, type M37ContributedPermissionKey } from "@wardenx/auth";

// §4.4 — the outbox event catalog (the composition root merges it into the boot catalog).
export { M37_OUTBOX_EVENTS } from "./events-by-m37";

// §4.1 — the route mount + Drizzle route service (T11b core spine).
export { mountM37Routes, type M37MountDeps } from "./routes/mount";
export {
  buildDrizzleIpuRouteService,
  type IpuRouteServiceDeps,
  type WriteOutboxPort,
} from "./routes/service-drizzle";
export type { IpuRouteService } from "./routes/service";

// §7.7 — the `ipu_record` destruction eraser (registered over the Phase-0 deny-stub by the composition root).
export { eraseIpuRecord, registerIpuErasers } from "./eraser";

// F-158-followup (#248) — the §4.5 `m6.admission.discharged` cascade-discharge consumer, M37's first.
export {
  M37_ADMISSION_DISCHARGED_CONSUMER,
  buildM37AdmissionDischargedConsumer,
  type AdmissionDischargedConsumerDeps,
} from "./consumers/m6-admission-discharged";

// §4.11 — the eight published IPU reader seams (registered over the deny-stubs by the composition root).
export {
  buildIpuSeams,
  getIpuAdmissionStatusReader,
  getIpuOrderReader,
  getIpuRoomingFactsReader,
  getIpuVisitorConsentGate,
  registerIpuSeams,
} from "./seams";

// D16 — the AI-prohibited-zone boot validator (§8.6). Re-exported from @wardenx/inpatient; the composition
// root invokes it in a db-present onReady hook against the real M32 AIPromptRegistry seam.
export {
  type IpuAiPromptRegistryPort,
  IpuAIBlockViolation,
  validateIpuAIBlock,
} from "@wardenx/inpatient";

// F-071 (#174) — the §4.8 `ipu.rn-coverage-watchdog` cron: the producer for the `ipu_rn_coverage_window`
// materialized invariant that four write paths read and nothing ever wrote.
export {
  COVERAGE_LOOKAHEAD_HOURS,
  COVERAGE_LOOKBACK_HOURS,
  COVERAGE_WINDOW_HOURS,
  M37_JOB_SCHEDULES,
  M37_QUEUES,
  M37_QUEUE_PARAMS,
  planCoverageAlerts,
  resolveAlertHorizonHours,
} from "./jobs/index";
export {
  type M37WorkerDeps,
  buildM37WorkerDeps,
  registerM37CronWorkers,
  runRnCoverageWatchdogCron,
  scheduleM37Jobs,
} from "./jobs/cron-workers";
export { M37_PLATFORM_JOB_ID, wireM37Tenancy } from "./wiring";
