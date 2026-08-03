// apps/backend/src/modules/26-cap — Module 26 (Cap Management) backend surface.
//
// The public boot surface the composition root (apps/backend/src/index.ts) imports to wire M26 at boot,
// mirroring the M25/M27 NN-module/index.ts precedent. P3 ships the §4.1 route mount + Drizzle READ/WRITE
// services, the §4.6 permission keys, the §4.7 ABAC predicate resolvers, the §4.10 outbox-event catalog,
// and the §4.3 published-seam implementations. The §4.8 BullMQ workers + the §3.7 eraser land in P4.

// §4.10 — the M26 outbox-event catalog (the dispatcher validates each `m26.cap.*` publish against it).
export { M26_OUTBOX_EVENTS } from "./events-by-m26";

// §4.6 — the fourteen permission keys M26 contributes to M3's catalog.
export {
  type M26ContributedPermissionKey,
  type M26PermissionKey,
  M26_CONTRIBUTED_PERMISSIONS,
  M26_PERMISSION_KEY_LIST,
} from "./permission-keys";

// §4.7 — the five ABAC predicate resolvers M26 owns + registers into M3's named-predicate registry.
export {
  type M26RegisteredAbacPredicate,
  type ReadingM26AbacDeps,
  type ReadingM26AbacResolver,
  M26_REGISTERED_ABAC_PREDICATES,
  buildDrizzleM26AbacResolver,
  buildM26AbacPredicates,
  denyStubM26AbacResolver,
  registerM26AbacPredicates,
} from "./abac-predicates";

// §4.1 — the route mount + the Drizzle-backed READ + WRITE service builders.
export {
  type M26ReadService,
  type M26WriteService,
  type M26RouteServices,
  type WriteOutboxPort,
  type OutboxEmission,
  buildDrizzleM26ReadService,
  buildDrizzleM26WriteService,
} from "./routes/index";
export { mountM26Routes } from "./routes/mount";

// §4.3 — the six published-seam implementations + the M1 SeamRegistry registration. `CapAccrualReader` is
// registered live (the M27 cost-report cap bind); the others stay outbox-reachable until their consumers wire.
export { type M26SeamImpls, buildM26SeamImpls } from "./seam-impls";
export { registerM26PublishedSeams } from "./wiring";

// §3.7 / D14 — the M4 destruction-registry `cap` eraser (per-patient redact-to-sentinel retaining aggregates;
// + the tenant-offboarding destruction entry). Registered over the Phase-0 deny-stub by the composition root.
export {
  CAP_DATA_CLASS,
  type CapEraserDeps,
  createCapEraser,
  createDrizzleCapRedactStore,
  createDrizzleCapTenantStore,
  eraseCapForTenant,
  registerCapErasers,
} from "./erasers/cap-eraser";

// §4.4 — the upstream-event consumer surface (m25 remittance / m23 claim / m5/m6 freeze / m36 alert).
// Forward-declared (the M25 posture); the live Drizzle accrual store binds with the M5/M6 readers.
export {
  type CapConsumerStore,
  type M26ConsumeReport,
  createInMemoryCapConsumerStore,
  dispatchM26UpstreamEvent,
  M26_UPSTREAM_SUBSCRIPTIONS,
  registerM26Consumers,
} from "./consumers/index";

// §4.8 — the six BullMQ cron queues + the worker/schedule construction (the M25 cron-runner shape; the M2
// active-org enumerator + the M36 alert router bind at boot, fail-closed until then).
export {
  type ActiveOrgListPort as M26ActiveOrgListPort,
  type WorkerAlertPort as M26WorkerAlertPort,
  type M26WorkerDeps,
  M26_CRON_QUEUES,
  M26_JOB_SCHEDULES,
  M26_QUEUE_PARAMS,
  registerM26CronWorkers,
  scheduleM26Jobs,
} from "./jobs/index";
