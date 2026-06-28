// apps/backend/src/modules/23-billing-medicare — Module 23 (Billing — Medicare) backend surface.
//
// The public boot surface the composition root (apps/backend/src/index.ts) imports to wire M23 at boot,
// mirroring the M27/M30/M33/M34 NN-module/index.ts precedent. P1 ships the CONTRACT surfaces only: the §4.10
// outbox-event catalog and the §4.6 contributed permission keys. The §4.7 ABAC predicate resolvers, the
// §4.1 route mount, the §4.8 BullMQ workers (claim/NOE/NOTR submit + retry, 999/277CA ack pulls, eligibility
// refresh, NOE/NOTR window-watch, MAC-portal health, the revalidate consumer), the §3.7 eraser registration,
// and the Drizzle-backed services land in P2/P3 (the M27 backend index is the shape this grows into).
//
// NB the §4.3 published reader seams (ClaimReader / ClaimDayProjectionProvider / ClaimSubmissionReader /
// ClaimMetricsProvider / MacCredentialAdmin) + the §4.4 consumed-seam bundle (M5/M6/M8/M18 readers, the M26
// CapProjectionProvider forward-seam deny-stub, M22/M36/M38/M40 seams, and the self-published
// `@wardenx/x12-837-client` X12WorkerClient) live in `@wardenx/billing` / `@wardenx/x12-837-client`. They are
// NOT wired into the M1 SeamRegistry here yet because M23's seam names are not yet members of the M1
// `SeamContracts` / `REQUIRED_SEAMS` (M1-owned); until then M23 is reachable cross-module via its §4.10 outbox
// events (the D2 outbox-only posture). Nothing here runs at import; the composition root opts M23 in at boot.
//
// AI-BLOCK (D13): Module 32 cannot create/modify/witness/resolve any M23 row. The dependency-cruiser boundary
// (no `packages/ai-platform/*` import from this module or `packages/billing` / `packages/x12-837-client`) and
// the per-route `actor_kind='ai_*'` reject land alongside the route mount in P3.
import { M23_OUTBOX_EVENTS } from "./events-by-m23";
import { M23_CONTRIBUTED_PERMISSIONS, M23_PERMISSION_KEY_LIST } from "./permission-keys";

// §4.10 — the M23 outbox-event catalog (the dispatcher validates each `m23.*` publish against it). The
// composition root merges this into the platform event catalog at boot (the M27/M30/M33/M34 precedent).
export { M23_OUTBOX_EVENTS } from "./events-by-m23";

// §4.6 — the twenty-eight permission keys M23 contributes to M3's catalog (the auth-package mirror-row
// projector consumes `M23_CONTRIBUTED_PERMISSIONS`; routes gate on these keys via requirePermission).
export {
  type M23ContributedPermissionKey,
  type M23PermissionKey,
  M23_CONTRIBUTED_PERMISSIONS,
  M23_PERMISSION_KEY_LIST,
} from "./permission-keys";

// ── P2/P3 boot surfaces (NOT YET IMPLEMENTED — stubs land per the M27 precedent) ──────────────────────
// §4.7  — registerM23AbacPredicates: the four predicate resolvers (provider_entity_billing_scope /
//         claim_in_billing_manager_caseload / override_role_eligible / regulatory_required_rule_protected)
//         registered into M3's named-predicate registry; deny-stub without a db handle. (P3)
// §4.1  — mountM23Routes + buildDrizzleM23ReadService / buildDrizzleM23WriteService over the Drizzle repos. (P3)
// §4.8  — registerM23Workers / registerM23CronWorkers / scheduleM23Jobs over the injected Valkey connection
//         (claim.submit[.retry], noe.submit, notr.submit, ack.pull-999, ack.pull-277ca, eligibility.refresh,
//         noe/notr.window-watch, eligibility.stale-watch, mac-portal.health, revalidate.consumer). (P3)
// §3.7  — registerBillingErasers: the M4 destruction-registry eraser for the M23 operational classes
//         (the seven-year compliance-class billing-record tables are destruction-blocked). (P3)
//
// The composition root (apps/backend/src/index.ts) is NOT edited in P1 — Integrate/P3 wires the above. Until
// then importing this module yields the two contract surfaces only, which is what the M1 boot catalog +
// the M3 permission-mirror projector consume.

/**
 * P1 marker — the module is reachable and exports its §4.10 + §4.6 contract surfaces. The composition root
 * does not call this in P1; it exists so the Integrate phase has a single named boot entry to grow into
 * (the M27 `registerM27*` family). Returns the contract surfaces for boot-catalog UPSERT convenience.
 */
export function getM23BootContracts() {
  return {
    outboxEvents: M23_OUTBOX_EVENTS,
    contributedPermissions: M23_CONTRIBUTED_PERMISSIONS,
    permissionKeyList: M23_PERMISSION_KEY_LIST,
  } as const;
}
