// apps/backend/src/modules/33-reporting — Module 33 (Reporting & Dashboards) backend surface.
// The §4.10 outbox-event catalog ships first; routes / ABAC predicates / permission keys / alert-rule
// seeds land in later phases. The composition root merges M33_OUTBOX_EVENTS into the platform event
// catalog at boot (the M34 events-by-m34 precedent).
export { M33_OUTBOX_EVENTS } from "./events-by-m33";

// GAP-051 — the §1.1 render handshake's DOWNSTREAM half: the live `m22.document.rendered` consumer that
// settles a scheduled-report occurrence `delivered` with its M22 `document_id`.
export {
  M33_DOCUMENT_BACKREF_CONSUMER,
  buildM33DocumentBackrefConsumer,
} from "./outbox-consumers/m22-document-rendered";

// §4.6 — the thirty-three permission keys M33 contributes to M3's catalog (the auth-package mirror-row
// projector consumes `M33_CONTRIBUTED_PERMISSIONS`; the route layer gates on these keys, later phase).
export {
  type M33ContributedPermissionKey,
  M33_CONTRIBUTED_PERMISSIONS,
  M33_PERMISSION_KEYS,
  M33_PERMISSIONS,
} from "./permission-keys";

// §4.7 — the two ABAC predicate resolvers M33 owns + registers into M3's named-predicate registry.
// `registerM33AbacPredicates` is invoked at boot by the composition root, idempotently; it defaults to
// the deny-stub resolver until P2C binds the real M2 `SupervisorReader` / M5 `CaseloadProvider` seams.
export {
  type ReportableScopeEnvelope,
  type ReportableScopeKind,
  type ReportingAbacDeps,
  type ReportingAbacResolver,
  type ReportViewFacts,
  M33_ABAC_PREDICATES,
  buildM33AbacPredicates,
  denyStubReportingAbacResolver,
  registerM33AbacPredicates,
  resolveReportableScope,
} from "./abac-predicates";
// F-044 — the PRODUCTION §4.7 resolver (Drizzle `report_view` facts under the caller's own RLS scope).
// Without it `dashboard_visibility` ran on the deny-stub and refused every caller, a dashboard's owner
// included.
export { buildDrizzleReportingAbacResolver } from "./abac-resolver-db";

// §4.1/§4.2 — the route surface (READ + WRITE + EXPORT/DRILLDOWN). The composition root mounts these over
// the Drizzle-backed route services when a DB client is present (the M34 `mountTenantPlatformRoutes`
// precedent); each mount aggregates its per-file `register*Routes` Fastify plugins.
export {
  mountM33ReadRoutes,
  mountM33WriteRoutes,
  mountM33ExportDrilldownRoutes,
} from "./routes/index";

// §3.7 / D6 — the M4 destruction-registry `reporting_class` eraser (tenant-offboarding operational-row
// cleanup; the compliance-class `report_drilldown_audit` is destruction-blocked). Registered over the
// Phase-0 deny-stub by the composition root's `registerModuleErasers` hook.
export {
  type DrizzleReportingEraseDeps,
  type ReportingEraserDeps,
  createDrizzleReportingEraseStore,
  createReportingEraser,
  registerReportingErasers,
} from "./erasers/reporting-eraser";

// §4.8 — the LIVE BullMQ worker construction + cron-schedule registration. Constructed at boot ONLY when a
// Valkey connection is present (the M34 `registerM34Workers`/`scheduleM34Jobs` worker-runner precedent).
export {
  type M33WorkerDeps,
  M33WorkerPortUnbound,
  buildM33MvRefreshEnqueue,
  buildM33WorkerDeps,
  buildM33WorkerPorts,
  registerM33Workers,
  scheduleM33Jobs,
} from "./jobs/m33-jobs";

// Phase-2C composition glue (the M34 wiring.ts precedent): the tenancy allowlist registration, the §4.8
// read-side queue producer, and the Drizzle-backed route-service builders the composition root assembles.
export {
  type M33InfraPortUnbound,
  LIVE_CRON,
  M33_PLATFORM_JOB_ID,
  buildDrizzleM33ExportDrilldownService,
  buildDrizzleM33ReadService,
  buildDrizzleM33WriteService,
  buildM33ReadEnqueue,
  registerReportingMetricsSeam,
  wireM33Tenancy,
} from "./wiring";
