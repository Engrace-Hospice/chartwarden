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
