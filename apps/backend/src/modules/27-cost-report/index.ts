// apps/backend/src/modules/27-cost-report — Module 27 (Cost Report) backend surface.
//
// The public boot surface the composition root (apps/backend/src/index.ts) imports to wire M27 at boot,
// mirroring the M30/M33/M34 NN-module/index.ts precedent. P1 ships the CONTRACT surfaces only: the §4.10
// outbox-event catalog and the §4.6 contributed permission keys. The §4.7 ABAC predicate resolvers, the
// §4.1 route mount, the §4.8 BullMQ workers, the §3.7 eraser registration, and the Drizzle-backed
// services land in P3 (the M30 backend index is the shape this grows into).
//
// NB the SEVEN §4.3 published seams (CostReportProvider / CostReportFilingStatusReader / EcrArtifactReader
// / ValidationResultProvider / XeroClientFactory / GustoClientFactory / CostReportMetricsProvider) + the
// §4.4 consumed-seam bundle (incl. the M23/M26 forward-seam deny-stubs) live in `@wardenx/cost-report`
// (registerM27PublishedSeams / M27_REQUIRED_SEAMS / makeDenyStub). They are NOT wired into the M1
// SeamRegistry here yet because M27's seam names are not yet members of the M1 `SeamContracts` /
// `REQUIRED_SEAMS` (M1-owned) — adding those entries is a foundation change outside this slice; until
// then M27 is reachable cross-module via its §4.10 outbox events (M27's outbox-only posture, D11).

// §4.10 — the M27 outbox-event catalog (the dispatcher validates each `m27.*` publish against it). The
// composition root merges this into the platform event catalog at boot (the M30/M33/M34 precedent).
export { M27_OUTBOX_EVENTS } from "./events-by-m27";

// §4.6 — the fourteen permission keys M27 contributes to M3's catalog (the auth-package mirror-row
// projector consumes `M27_CONTRIBUTED_PERMISSIONS`; routes gate on these keys via requirePermission).
export {
  type M27ContributedPermissionKey,
  M27_CONTRIBUTED_PERMISSIONS,
  M27_PERMISSION_KEY_LIST,
} from "./permission-keys";

// §4.7 / §6.7 — the three ABAC predicate resolvers M27 owns + registers into M3's named-predicate registry.
// `registerM27AbacPredicates` is invoked at boot by the composition root, idempotently; the composition root
// passes `{ db }` so the predicates resolve owner facts via `buildDrizzleM27AbacResolver` under RLS. With no
// db handle it defaults to the deny-stub resolver (the M30 `registerM30AbacPredicates` precedent).
export {
  type CostReportAbacFacts,
  type M27AbacReadContext,
  type MembershipProviderScope,
  type ReadingM27AbacDeps,
  type ReadingM27AbacResolver,
  type M27RegisteredAbacPredicate,
  M27_REGISTERED_ABAC_PREDICATES,
  buildDrizzleM27AbacResolver,
  buildM27AbacPredicates,
  denyStubM27AbacResolver,
  registerM27AbacPredicates,
} from "./abac-predicates";

// §4.1 — the eleven route plugins + the Drizzle-backed READ + WRITE route-service builders. The composition
// root mounts these over the Drizzle services when a DB client is present (the M30 `mountM30Routes` precedent).
export {
  type M27CombinedRouteService,
  type M27RouteServices,
  type M27ReadRouteService,
  type M27WriteRouteService,
  type M27ReadServicePorts,
  type M27WriteServicePorts,
  buildDrizzleM27ReadService,
  buildDrizzleM27WriteService,
} from "./routes/index";
export { mountM27Routes } from "./routes/mount";

// §3.7 / D11 — the M4 destruction-registry `cost_report_class` eraser (tenant-offboarding operational-row
// cleanup; the compliance-class survey-evidence tables are destruction-blocked). Registered over the Phase-0
// deny-stub by the composition root's `registerModuleErasers` hook.
export {
  type CostReportEraserDeps,
  COST_REPORT_DATA_CLASS,
  createCostReportEraser,
  registerCostReportErasers,
} from "./erasers/cost-report-eraser";

// §4.8 — the LIVE BullMQ worker/cron boot surface (the M30 `registerM30Workers` / `scheduleM30Jobs`
// precedent). The composition root constructs the §4.8 work-queue Workers + the cron consumers + the
// repeatable cron-schedule Queues over the injected Valkey connection, binding each worker's ports (the M27
// repos + the LIVE-if-bound M6/M8/M12/M13/M40 consumers + the M23/M26 forward-seam deny-stubs reached via
// `getSeam`) while the still-unlanded platform infra (outbox dispatcher / envelope-DEK / M36 alert router)
// fails closed at RUN time (RULE 3/4). Nothing here runs at import.
export {
  M27_CRON_QUEUES,
  type M27CronQueueName,
  M27_IDEMPOTENCY_KEYS,
  M27_JOB_SCHEDULES,
  type M27QueueName,
  type M27QueueParam,
  M27_QUEUE_PARAMS,
  M27_QUEUES,
  type M27WorkerDeps,
  buildM27WorkerDeps,
  registerM27CronWorkers,
  registerM27Workers,
  scheduleM27Jobs,
} from "./jobs/index";
