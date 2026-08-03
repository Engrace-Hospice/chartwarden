// apps/backend/src/modules/30-quality — Module 30 (HQRP & Quality) backend surface.
//
// The public boot surface the composition root (apps/backend/src/index.ts) imports to wire M30 at boot,
// mirroring the M33 33-reporting/index.ts precedent: the §4.10 outbox-event catalog, the §4.6 contributed
// permission keys, the §4.7 ABAC predicate registration, the §4.1 route mount, the §3.7 `quality_class`
// eraser registration, the Drizzle-backed route-service builders, and the §4.8 recompute queue producer.
//
// NB the FIVE §4.3 published seams (QualityMeasureProvider / IncidentRegisterProvider / QapiProjectProvider /
// ComplianceStatusProvider / SecurityRiskAssessmentReader) + the §4.4 consumed-seam bundle live in
// `@wardenx/quality` (registerQualityPublishedSeams / bindQualityConsumedSeams). They are NOT wired into the
// M1 SeamRegistry here because M30's seam names are not yet members of the M1 `SeamContracts`/`REQUIRED_SEAMS`
// (M1-owned) — adding those entries is a foundation change outside this slice; until then M30 is reachable
// cross-module only via its §4.10 outbox events, which is M30's outbox-only posture across boundaries (D6).

// §4.10 — the M30 outbox-event catalog (the dispatcher validates each `m30.*` publish against it). The
// composition root merges this into the platform event catalog at boot (the M33/M34 events-by-mN precedent).
export { M30_OUTBOX_EVENTS } from "./events-by-m30";

// §4.6 — the thirty-three permission keys M30 contributes to M3's catalog (the auth-package mirror-row
// projector consumes `M30_CONTRIBUTED_PERMISSIONS`; the route layer gates on these keys via requirePermission).
export {
  type M30ContributedPermissionKey,
  M30_CONTRIBUTED_PERMISSIONS,
  M30_PERMISSION_KEYS,
  M30_PERMISSION_KEY_LIST,
} from "./permission-keys";

// §4.7 / §6.7 — the eleven ABAC predicate resolvers M30 owns + registers into M3's named-predicate registry.
// `registerM30AbacPredicates` is invoked at boot by the composition root, idempotently; the composition root
// passes `{ db }` so the predicates resolve owner facts via `buildDrizzleM30AbacResolver` under RLS (P2c).
// With no db handle it defaults to the deny-stub resolver. The M5 PrivacyFlag / M39 consent reach behind
// `part2Redisclosure` stays fail-closed (not in the M1 SeamContracts).
export {
  type IncidentAbacFacts,
  type M30AbacReadContext,
  type MortalityReviewAbacFacts,
  type QapiProjectAbacFacts,
  type ReadingM30AbacDeps,
  type ReadingM30AbacResolver,
  type SraCycleAbacFacts,
  type M30RegisteredAbacPredicate,
  M30_REGISTERED_ABAC_PREDICATES,
  buildDrizzleM30AbacResolver,
  buildM30AbacPredicates,
  denyStubM30AbacResolver,
  registerM30AbacPredicates,
} from "./abac-predicates";

// §4.1 — the nine route plugins (measures / CAHPS / risk-register / QAPI / SRA / CoP / incidents / mortality /
// infection) + the Drizzle-backed READ + WRITE route-service builders. The composition root mounts these over
// the Drizzle services when a DB client is present (the M33 `mountM33ReadRoutes` precedent).
export {
  type M30CombinedRouteService,
  type M30RouteServices,
  type M30ReadRouteService,
  type M30WriteRouteService,
  type M30ReadServicePorts,
  type M30WriteServicePorts,
  buildDrizzleM30ReadService,
  buildDrizzleM30WriteService,
  mountM30Routes,
} from "./routes/index";

// §3.7 / D6 — the M4 destruction-registry `quality_class` eraser (tenant-offboarding operational-row cleanup;
// the compliance-class survey-evidence tables are destruction-blocked). Registered over the Phase-0 deny-stub
// by the composition root's `registerModuleErasers` hook.
export {
  type DrizzleQualityEraseDeps,
  type QualityEraserDeps,
  QUALITY_DATA_CLASS,
  createDrizzleQualityEraseStore,
  createQualityEraser,
  registerQualityErasers,
} from "./erasers/quality-eraser";

// Integrate-phase composition glue (the M33 wiring.ts precedent): the §4.8 recompute/risk-refresh BullMQ
// producer the R-04 / R-96 command routes enqueue onto.
export {
  M30InfraPortUnbound,
  M30_PLATFORM_JOB_ID,
  buildM30RecomputeEnqueue,
  wireM30Tenancy,
} from "./wiring";

// §4.8 — the LIVE BullMQ worker/cron boot surface (the M33 `registerM33Workers` / `scheduleM33Jobs`
// precedent). The composition root constructs the four §4.8 work-queue Workers + the four standalone cron
// consumers + the four repeatable cron-schedule Queues over the injected Valkey connection, binding each
// worker's ports (the M30 repos + the PRIMARY-pool MV refresh + the LIVE M10 HOPE consumer reached via
// `getSeam`) while the still-unlanded platform infra (outbox dispatcher / envelope-DEK / M36 alert router)
// fails closed at RUN time (RULE 3). Nothing here runs at import.
export {
  type M30CronPortBundles,
  type M30CronQueueName,
  type M30WorkerDeps,
  type M30WorkerPortBundles,
  M30_CRON_QUEUES,
  buildM30CronPorts,
  buildM30WorkerDeps,
  buildM30WorkerPorts,
  registerM30CronWorkers,
  registerM30Workers,
  scheduleM30Jobs,
} from "./jobs/index";

// §4.3 — the FIVE published seams, registered into the M1 SeamRegistry at boot (the M23/M26 precedent).
// M30's seam names are now members of the M1 `SeamContracts` / `REQUIRED_SEAMS`, so M22 / M28 / M33 / M34
// reach the measure ledger, the incident register, QAPI, CoP status and the SRA posture through `getSeam`
// instead of M30 being outbox-only across boundaries.
export {
  type M30PublishedSeamOptions,
  buildM30PublishedSeams,
  registerM30PublishedSeams,
} from "./published-seams";

// §4.4 — the M23/M27 forward-seam binds. Both producers are built and publish into the M1 registry, so
// these adapters replace the `QUALITY_FORWARD_SEAM_DENY_STUBS` entries for `billing` and `costReport`
// (M15/M16 stay stubbed — still unbuilt). Each DEGRADES PER METHOD to the forward-seam marker, so an
// unavailable read suppresses its measure and never substitutes a zero.
export {
  buildM30BillingConsumer,
  buildM30CostReportConsumer,
  buildM30LiveForwardSeams,
} from "./consumed-seam-adapters";
