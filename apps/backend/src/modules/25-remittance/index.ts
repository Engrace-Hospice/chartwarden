// apps/backend/src/modules/25-remittance — M25 Remittance & Denials backend surface. The pure
// revenue-cycle domain (Phase 2) is in ./domain; the X12 5010 835 sidecar adapter is
// @wardenx/x12-835-client. Phase 3 adds the contract surfaces (the §4.5 outbox catalog + the §4.6
// permission keys), then services (ingest/parse/post/match/classify/state), routes, workers, the eight
// reader seams, the M36 recipient resolver, the two ABAC predicates, the destruction eraser, and boot
// wiring. The composition root opts M25 in at boot (the M23/M27 NN-module/index.ts precedent).
export * as domain from "./domain";

// §4.5 — the M25 outbox-event catalog (the dispatcher validates each `m25.*` publish against it). The
// composition root merges this into the platform event catalog at boot.
export { M25_OUTBOX_EVENTS } from "./events-by-m25";

// §4.6 — the twenty-two permission keys M25 contributes to M3's catalog (the auth-package mirror-row
// projector consumes `M25_CONTRIBUTED_PERMISSIONS`; routes gate on these keys via requirePermission).
export {
  type M25ContributedPermissionKey,
  type M25PermissionKey,
  M25_CONTRIBUTED_PERMISSIONS,
  M25_PERMISSION_KEY_LIST,
} from "./permission-keys";

// §4.7 — the two ABAC predicate resolvers (`claim_assigned_to_actor`, `appeal_within_deadline`) M25 owns
// + registers into M3's named-predicate registry. `registerM25AbacPredicates` is invoked at boot by the
// composition root; passing `{ db }` resolves facts under RLS, else the fail-closed deny-stub (M27 precedent).
export {
  type ReadingM25AbacDeps,
  type ReadingM25AbacResolver,
  type M25RegisteredAbacPredicate,
  M25_REGISTERED_ABAC_PREDICATES,
  buildDrizzleM25AbacResolver,
  buildM25AbacPredicates,
  denyStubM25AbacResolver,
  registerM25AbacPredicates,
} from "./abac-predicates";

// §4.1 — the route plugins + the Drizzle-backed read/write service builders. The composition root mounts
// these over the Drizzle services when a DB client is present (the M27 `mountM27Routes` precedent); the
// write service's outbox port + the read service's M38 terminology lookup are injected at boot (deny-stub /
// no-op until wired).
export {
  type M25RouteServices,
  type M25ReadService,
  type M25WriteService,
  type WriteOutboxPort,
  type OutboxEmission,
  type TerminologyLookupPort,
  buildDrizzleM25ReadService,
  buildDrizzleM25WriteService,
} from "./routes/index";
export { mountM25Routes } from "./routes/mount";

// §4.4 — the upstream outbox consumers (m23.claim.rejected, m18.evv.aggregator_rejected,
// m22.document.rendered → denial seed / EVV back-link / document back-reference). Pure handlers over an
// injected store; module-only (NOT wired into the dispatcher subscription yet — the M23 conservative posture).
export {
  type DenialSeedStore,
  type DenialOpenedEmission,
  M25_OUTBOX_SUBSCRIPTIONS,
  handleClaimRejected,
  handleEvvAggregatorRejected,
  handleDocumentRendered,
} from "./consumers/handlers";

// §4.8 — the nightly cron handlers (denial-aging rebucket + threshold alerts; appeal-deadline T-30/14/7/1
// alerts). Pure over injected stores; the BullMQ/cron binding lands at boot (module-only here).
export {
  type DenialAgingStore,
  type AppealDeadlineStore,
  type AlertEmission,
  runDenialAging,
  runAppealDeadlineWatch,
} from "./jobs/m25-jobs";

// §3.7 / §8.4 — the M4 `remittance` destruction eraser (PR-ledger per-patient erase; the line history rolls
// off via the M4 partition manager). Registered over the Phase-0 deny-stub via the injected registerEraser
// hook by the composition root's registerModuleErasers (the M23 import-boundary posture).
export {
  type RemittanceEraseStore,
  type RemittanceEraserDeps,
  type RegisterEraserHook,
  REMITTANCE_DATA_CLASS,
  createRemittanceEraser,
  registerRemittanceErasers,
} from "./erasers/remittance-eraser";
