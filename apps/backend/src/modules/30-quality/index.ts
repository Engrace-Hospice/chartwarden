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
// `registerM30AbacPredicates` is invoked at boot by the composition root, idempotently; it defaults to the
// deny-stub resolver until P2C binds the real Drizzle + M5 PrivacyFlag / M39 consent reach.
export {
  type IncidentAbacFacts,
  type MortalityReviewAbacFacts,
  type QapiProjectAbacFacts,
  type ReadingM30AbacDeps,
  type ReadingM30AbacResolver,
  type SraCycleAbacFacts,
  type M30RegisteredAbacPredicate,
  M30_REGISTERED_ABAC_PREDICATES,
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
  type QualityEraserDeps,
  QUALITY_DATA_CLASS,
  createQualityEraser,
  registerQualityErasers,
} from "./erasers/quality-eraser";

// Integrate-phase composition glue (the M33 wiring.ts precedent): the §4.8 recompute/risk-refresh BullMQ
// producer the R-04 / R-96 command routes enqueue onto.
export { M30InfraPortUnbound, buildM30RecomputeEnqueue } from "./wiring";
