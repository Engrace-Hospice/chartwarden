// apps/backend/src/modules/24-billing-medicaid — Module 24 (Billing — Medicaid) backend surface.
//
// The public boot surface the composition root (apps/backend/src/index.ts) imports to wire M24 at boot,
// mirroring the M25/M26 NN-module/index.ts precedent. P3 ships the §4.1 route mount + Drizzle READ/WRITE
// services, the §4.7 permission keys, the §4.8 ABAC predicate resolvers, the §4.11 outbox-event catalog, the
// §3.7 eraser, the §4.4 upstream consumers, the §4.9 job surface, and the §4.3 published-seam impls. The live
// per-state adapter wire I/O + the consumed M5/M6/M8/M18/M23/M26/M38/M40 reader binds are deferred follow-ups.

// §4.11 — the M24 outbox-event catalog (the dispatcher validates each `m24.*` publish against it).
export { M24_OUTBOX_EVENTS } from "./events-by-m24";
// §8.7 trading-partner secret envelope crypto (per-tenant HKDF DEK + AES-256-GCM). The composition root
// binds the port into the WRITE service; `isUsableCipher` backs the read surface's presence flags.
export {
  type CredentialCipherPort,
  buildCredentialCipherPort,
  deriveOrgCredentialDek,
  isUsableCipher,
  loadCredentialKek,
  openCredentialSecret,
  sealCredentialSecret,
} from "./credential-crypto";

// §4.7 — the twenty-six permission keys M24 contributes to M3's catalog.
export {
  type M24ContributedPermissionKey,
  type M24PermissionKey,
  M24_CONTRIBUTED_PERMISSIONS,
  M24_PERMISSION_KEY_LIST,
} from "./permission-keys";

// §4.8 — the six ABAC predicate resolvers M24 owns + registers into M3's named-predicate registry.
export {
  type M24RegisteredAbacPredicate,
  type ReadingM24AbacDeps,
  type ReadingM24AbacResolver,
  M24_REGISTERED_ABAC_PREDICATES,
  buildDrizzleM24AbacResolver,
  buildM24AbacPredicates,
  denyStubM24AbacResolver,
  registerM24AbacPredicates,
} from "./abac-predicates";

// §4.1 — the route mount + the Drizzle-backed READ + WRITE service builders.
export {
  type M24ReadService,
  type M24WriteService,
  type M24RouteServices,
  type WriteOutboxPort,
  type OutboxEmission,
  buildDrizzleM24ReadService,
  buildDrizzleM24WriteService,
} from "./routes/index";
export { mountM24Routes } from "./routes/mount";

// §4.3 — the eight published reader-seam implementations (built, registration deferred — the M26 posture).
export { type M24SeamImpls, buildM24SeamImpls } from "./seam-impls";
export { registerM24PublishedSeams } from "./wiring";

// §3.7 / §8.4 — the M4 destruction-registry `medicaid_billing_record` eraser (registerEraser INJECTED).
export {
  MEDICAID_BILLING_DATA_CLASS,
  type MedicaidEraserDeps,
  type MedicaidRedactStore,
  createMedicaidEraser,
  createDrizzleMedicaidRedactStore,
  registerMedicaidErasers,
} from "./erasers/medicaid-eraser";

// §4.4 — the upstream-event consumer surface (M25 remittance / M23 medicare-primary / M5·M6·M8·M18·M40 change).
export {
  type M24ConsumerStore,
  type M24ConsumeReport,
  createInMemoryM24ConsumerStore,
  dispatchM24UpstreamEvent,
  M24_UPSTREAM_SUBSCRIPTIONS,
  registerM24Consumers,
} from "./consumers/index";

// §4.9 — the BullMQ queue/cron catalog + the worker/schedule construction (boot wiring deferred — adapter).
export {
  type ActiveOrgListPort as M24ActiveOrgListPort,
  type M24WorkerDeps,
  M24_QUEUES,
  M24_CRON_QUEUES,
  M24_JOB_SCHEDULES,
  M24_QUEUE_PARAMS,
  registerM24CronWorkers,
  scheduleM24Jobs,
} from "./jobs/index";
