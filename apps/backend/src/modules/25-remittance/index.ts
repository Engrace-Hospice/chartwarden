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
