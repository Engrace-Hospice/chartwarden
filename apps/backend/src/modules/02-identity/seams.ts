// apps/backend/src/modules/02-identity/seams.ts — M2-T07 seam registration (M2 spec §4.7).
//
// M2 publishes two boot-validated cross-module seams; this is the module-owned init that
// registers their REAL implementations into the M1 seam registry, overwriting the Phase-0
// deny-stubs. Per ADR-0005 D1 the interfaces live in @chartwarden/types (leaf) and the producer
// implementations in @chartwarden/auth (M2's own codePath, a foundation-helper package) — so a
// consumer module resolves them via getSeam() with no dependsOn edge on M2.
//
//   • SessionContextResolver — the authenticated, org-scoped request context. M3's
//     `step_up_recent` predicate reads `lastStepUpAt`/`lastStepUpFactor` through it; M4 reads
//     the actor for the audit trail.
//   • AuditorSessionMinter   — M3 owns the `auditor_engagement`; M2 mints its time-boxed
//     magic-link session (D4).
//   • PortalSessionBinder    — M31 owns the portal account + grant; M2 writes the resulting session
//     CLASS and scope onto the `session` row (F-030). Until this existed, no session could carry a
//     portal class, so every `portal.*` ABAC predicate denied unconditionally.
//   • VendorSessionBinder    — the same seam one module over: M19 owns the `external_triage_vendor`
//     row and the shift that puts it on call; M2 writes the class + `scope.externalActorId` (F-030).
//     Until this existed, `external_triage_actor` compared the shift's vendor against `undefined`.
//
// The composition root (apps/backend/src/index.ts `wireModuleSeams`) invokes this inside the
// boot gate, AFTER M1's wireSeams() no-op and BEFORE validateSeams(), so the real seams stand
// and validation passes. M1 cannot import this file (no M1→M2 edge); the call is driven from
// the composition root, which is exempt from module boundaries.
//
// SLICE NOTE: each seam is wired over an injected slice-safe in-memory port by default
// (no live DB/Valkey). Production passes the real `SessionContextStore` (M1 `session` repo
// inside withOrgContext) and `AuditorMagicLinkIssuer` (Valkey one-time token) through `deps`.
import {
  type AuditorMagicLinkIssuer,
  type PortalSessionStore,
  type SessionContextStore,
  type StepUpOverrideStore,
  type VendorSessionStore,
  createAuditorSessionMinter,
  createInMemoryAuditorMagicLinkIssuer,
  createInMemoryPortalSessionStore,
  createInMemorySessionContextStore,
  createInMemoryVendorSessionStore,
  createPortalSessionBinder,
  createSessionContextResolver,
  createVendorSessionBinder,
} from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import { registerSeam } from "../../bootstrap/index";
import { createDbAuditorMagicLinkIssuer } from "./auditor-magic-link-store";
import {
  createDrizzleElevatedApprovalStore,
  createElevatedApprovalReader,
  createInMemoryElevatedApprovalStore,
} from "./elevated-approvals";
import { createOrganizationReader } from "./organization-reader";
import {
  createDrizzlePortalSessionStore,
  createDrizzleVendorSessionStore,
} from "./portal-session-store";
import { createDrizzleStepUpOverrideStore } from "./step-up-override-store";
import { createTenantOrgCreationProvider } from "./tenant-org-creation-provider";

/** Injected production adapters for M2's published seams (slice defaults to in-memory). */
export interface IdentitySeamDeps {
  /** Reads session context rows by id within an org scope (M1 `session` repo in production). */
  sessions?: SessionContextStore;
  /** Mints the one-time auditor magic-link token (Valkey TTL store in production). */
  auditorLinks?: AuditorMagicLinkIssuer;
  /** Writes the portal class + scope onto the `session` row (Drizzle store in production). */
  portalSessions?: PortalSessionStore;
  /** Writes the M19 vendor class + scope onto the `session` row (Drizzle store in production). */
  vendorSessions?: VendorSessionStore;
  /** Per-tenant step-up policy overrides (§4.3.2, D9). Defaults to the Drizzle store when a `db`
   *  is present, and to absent otherwise — absent means "every operation resolves to the floor". */
  stepUpOverrides?: StepUpOverrideStore;
  /** DB client for the `TenantOrgCreationProvider` (M34 §7.1 step 3) + the `OrganizationReader`
   *  (M35 admin lists, M35A-T03). Absent in slice/tests → the registry's fail-closed deny-stubs stand
   *  (org creation resolves `unavailable`; the reader resolves no names). */
  db?: DbClient;
  /** Separate least-privilege platform credential for organization-spine creation/cross-tenant reads. */
  organizationDb?: DbClient;
  /** GAP-006 - runs when the tenant org is confirmed/created (M3's role-template materializer, bound by the
   *  composition root because M2 may not import M3). Absent => the org is confirmed without roles. */
  onTenantOrganizationAvailable?: (organizationId: string) => Promise<void>;
}

/** Register M2's published seams into the M1 registry (M2-T07; call before validateSeams()). */
export function registerIdentitySeams(deps: IdentitySeamDeps = {}): void {
  const sessions = deps.sessions ?? createInMemorySessionContextStore().store;
  // GAP-011 — with a db the one-time token is persisted (hash only, `auditor_magic_link`); the in-memory
  // issuer stands only for db-less slices/tests.
  const auditorLinks =
    deps.auditorLinks ??
    (deps.db
      ? createDbAuditorMagicLinkIssuer(deps.db)
      : createInMemoryAuditorMagicLinkIssuer().issuer);
  // AC-03 — the per-tenant step-up override (§4.3.2, D9) rides on the SAME seam M3's
  // `step_up_recent` predicate already resolves, so no new seam and no new dependsOn edge. Without
  // a db the store is absent and every operation resolves to the platform floor: an override may
  // only ever TIGHTEN, so having none is the strict end, not a fail-open default.
  const stepUpOverrides =
    deps.stepUpOverrides ?? (deps.db ? createDrizzleStepUpOverrideStore(deps.db) : undefined);
  registerSeam("SessionContextResolver", createSessionContextResolver(sessions, stepUpOverrides));
  registerSeam("AuditorSessionMinter", createAuditorSessionMinter(auditorLinks));
  // F-030 — the portal class + scope writer. With a db this writes the real `session` row org-scoped;
  // without one the in-memory store answers for a slice, the same shape as every other seam here.
  registerSeam(
    "PortalSessionBinder",
    createPortalSessionBinder(
      deps.portalSessions ??
        (deps.db
          ? createDrizzlePortalSessionStore(deps.db)
          : createInMemoryPortalSessionStore().store),
    ),
  );
  // F-030 — the M19 vendor class + scope writer, the `PortalSessionBinder` shape one module over.
  registerSeam(
    "VendorSessionBinder",
    createVendorSessionBinder(
      deps.vendorSessions ??
        (deps.db
          ? createDrizzleVendorSessionStore(deps.db)
          : createInMemoryVendorSessionStore().store),
    ),
  );
  // GAP-043 — the per-membership named-approval-authority reader M27's §4.7 approver predicate keys on.
  // With a db it reads `membership_elevated_approval` under RLS; without one the in-memory store answers
  // `false` for everything, which is the same fail-closed shape the slice gets from every other seam here.
  registerSeam(
    "ElevatedApprovalReader",
    createElevatedApprovalReader(
      deps.db
        ? createDrizzleElevatedApprovalStore(deps.db)
        : createInMemoryElevatedApprovalStore().store,
    ),
  );
  // M34 §7.1 step 3 — the real org-creation provider, only when a DB client is present (the registry's
  // fail-closed deny-stub stands in slice/tests).
  const organizationDb = deps.organizationDb ?? deps.db;
  if (organizationDb) {
    registerSeam(
      "TenantOrgCreationProvider",
      createTenantOrgCreationProvider(organizationDb, {
        ...(deps.onTenantOrganizationAvailable
          ? { onOrganizationAvailable: deps.onTenantOrganizationAvailable }
          : {}),
      }),
    );
    // M35A-T03 — the real org display-metadata reader M35's platform-ops admin lists label rows through
    // (the registry's graceful deny-stub, which resolves no names, stands in slice/tests without a db).
    registerSeam("OrganizationReader", createOrganizationReader(organizationDb));
  }
}
