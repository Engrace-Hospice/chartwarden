// apps/backend/src/modules/35-subscription — Module 35 (Subscription Billing) backend surface.
//
// The public boot surface the composition root (apps/backend/src/index.ts) imports to wire M35 at boot,
// mirroring the M27/M28 NN-module/index.ts precedent. T06 ships the §4.1–4.3 route surface + the §4.7
// permission-key contribution + the §4.8 ABAC predicates + the §4.11 outbox-event catalog.
//
// NB the §4.5 six PUBLISHED seams + the §4.6 consumed-seam deny-stubs were bound into the M1 SeamRegistry
// in T05 (bootstrap/seams). T06 does NOT replace those deny-stubs with live impls (no in-scope consumer of
// M35's seams exists yet — M33 reporting, the first consumer, builds LAST in this wave); M35 stays reachable
// cross-module via its §4.11 outbox events (M35's outbox-only posture).

// §4.11 — the M35 outbox-event catalog (the dispatcher validates each `m35.*` publish against it). The
// composition root merges this into the platform event catalog at boot (the M27/M30/M33 precedent).
export { M35_OUTBOX_EVENTS } from "./events-by-m35";

// §4.7 — the twenty-six permission keys M35 contributes to M3's catalog (the auth-package mirror-row
// projector consumes `M35_CONTRIBUTED_PERMISSIONS`; routes gate on these keys via requirePermission).
export {
  type M35ContributedPermissionKey,
  M35_CONTRIBUTED_PERMISSIONS,
  M35_PERMISSION_KEY_LIST,
  M35_STEP_UP_PERMISSION_KEYS,
} from "./permission-keys";

// §4.8 — the five ABAC predicate resolvers M35 owns + registers into M3's named-predicate registry.
// `registerM35AbacPredicates` is invoked at boot by the composition root, idempotently. The predicates are
// pure (context/target); no db handle is needed.
export {
  type M35RegisteredAbacPredicate,
  M35_REGISTERED_ABAC_PREDICATES,
  buildM35AbacPredicates,
  registerM35AbacPredicates,
} from "./abac-predicates";

// §4.1–4.3 — the route mount + the Drizzle-backed route-service builder + the webhook ingest port. The
// composition root mounts these over the Drizzle service when a DB client is present (the M27 precedent).
export {
  type M35MountDeps,
  type M35RouteService,
  type M35RouteServiceDeps,
  type M35WebhookIngest,
  type M35WebhookResultKind,
  type PlatformRunner,
  type WebhookRouteDeps,
  type WriteOutboxPort,
  type WriteTx,
  buildDrizzleM35RouteService,
  mountM35Routes,
} from "./routes/index";
// F-162 (#248) — M35's first-ever outbox consumer: the §4.12 org-lifecycle-handler over M2's
// organization activate/suspend/close triggers.
export {
  M35_ORG_LIFECYCLE_CONSUMER,
  type OrgLifecycleConsumerDeps,
  buildM35OrgLifecycleConsumer,
} from "./outbox-consumers/m2-organization-lifecycle";
// F-172 (#248) — the real `PseudonymKeyProvider` (KEK envelope over the platform-singleton
// `patient_pseudonym_key`) + the §4.12 `user-active-period-aggregator` / `patient-active-period-aggregator`
// consumers it unblocks.
export {
  createDrizzlePseudonymKeyProvider,
  rotatePseudonymKey,
} from "./pseudonym-key-provider";
export {
  activePeriodRowExists,
  createDrizzleActivePeriodStore,
  markPatientInactiveForOrg,
} from "./active-period-store-drizzle";
export {
  M35_SESSION_CREATED_CONSUMER,
  type SessionCreatedConsumerDeps,
  buildM35SessionCreatedConsumer,
} from "./outbox-consumers/m2-session-created";
export {
  M35_PATIENT_ACTIVE_PERIOD_CONSUMER,
  type PatientActivePeriodConsumerDeps,
  buildM35PatientActivePeriodConsumer,
} from "./outbox-consumers/m5-patient-active-period";

// GAP-058 / GAP-059 / GAP-060 / GAP-061 - the Stripe transport binding, the webhook ingest + handler, the
// refund executor and the BullMQ worker set (dunning, usage, expiry watch, revenue, reconciler).
export { loadM35StripeConfig, type M35StripeConfig } from "./billing-runtime/stripe-config";
export { buildM35WebhookIngest } from "./billing-runtime/webhook-ingest";
export {
  M35_JOBS_PLATFORM_JOB_ID,
  registerM35Workers,
  scheduleM35Jobs,
} from "./billing-runtime/workers";
export type { M35JobDeps } from "./billing-runtime/jobs";
