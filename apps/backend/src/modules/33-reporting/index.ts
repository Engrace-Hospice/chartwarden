// apps/backend/src/modules/33-reporting — Module 33 (Reporting & Dashboards) backend surface.
// The §4.10 outbox-event catalog ships first; routes / ABAC predicates / permission keys / alert-rule
// seeds land in later phases. The composition root merges M33_OUTBOX_EVENTS into the platform event
// catalog at boot (the M34 events-by-m34 precedent).
export { M33_OUTBOX_EVENTS } from "./events-by-m33";

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
