// apps/backend/src/modules/02-identity/seams.ts — M2-T07 seam registration (M2 spec §4.7).
//
// M2 publishes two boot-validated cross-module seams; this is the module-owned init that
// registers their REAL implementations into the M1 seam registry, overwriting the Phase-0
// deny-stubs. Per ADR-0005 D1 the interfaces live in @wardenx/types (leaf) and the producer
// implementations in @wardenx/auth (M2's own codePath, a foundation-helper package) — so a
// consumer module resolves them via getSeam() with no dependsOn edge on M2.
//
//   • SessionContextResolver — the authenticated, org-scoped request context. M3's
//     `step_up_recent` predicate reads `lastStepUpAt`/`lastStepUpFactor` through it; M4 reads
//     the actor for the audit trail.
//   • AuditorSessionMinter   — M3 owns the `auditor_engagement`; M2 mints its time-boxed
//     magic-link session (D4).
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
  type SessionContextStore,
  type StepUpOverrideStore,
  createAuditorSessionMinter,
  createInMemoryAuditorMagicLinkIssuer,
  createInMemorySessionContextStore,
  createSessionContextResolver,
} from "@wardenx/auth";
import type { DbClient } from "@wardenx/db";
import { registerSeam } from "../../bootstrap/index";
import {
  createDrizzleElevatedApprovalStore,
  createElevatedApprovalReader,
  createInMemoryElevatedApprovalStore,
} from "./elevated-approvals";
import { createOrganizationReader } from "./organization-reader";
import { createDrizzleStepUpOverrideStore } from "./step-up-override-store";
import { createTenantOrgCreationProvider } from "./tenant-org-creation-provider";

/** Injected production adapters for M2's published seams (slice defaults to in-memory). */
export interface IdentitySeamDeps {
  /** Reads session context rows by id within an org scope (M1 `session` repo in production). */
  sessions?: SessionContextStore;
  /** Mints the one-time auditor magic-link token (Valkey TTL store in production). */
  auditorLinks?: AuditorMagicLinkIssuer;
  /** Per-tenant step-up policy overrides (§4.3.2, D9). Defaults to the Drizzle store when a `db`
   *  is present, and to absent otherwise — absent means "every operation resolves to the floor". */
  stepUpOverrides?: StepUpOverrideStore;
  /** DB client for the `TenantOrgCreationProvider` (M34 §7.1 step 3) + the `OrganizationReader`
   *  (M35 admin lists, M35A-T03). Absent in slice/tests → the registry's fail-closed deny-stubs stand
   *  (org creation resolves `unavailable`; the reader resolves no names). */
  db?: DbClient;
  /** Separate least-privilege platform credential for organization-spine creation/cross-tenant reads. */
  organizationDb?: DbClient;
}

/** Register M2's published seams into the M1 registry (M2-T07; call before validateSeams()). */
export function registerIdentitySeams(deps: IdentitySeamDeps = {}): void {
  const sessions = deps.sessions ?? createInMemorySessionContextStore().store;
  const auditorLinks = deps.auditorLinks ?? createInMemoryAuditorMagicLinkIssuer().issuer;
  // AC-03 — the per-tenant step-up override (§4.3.2, D9) rides on the SAME seam M3's
  // `step_up_recent` predicate already resolves, so no new seam and no new dependsOn edge. Without
  // a db the store is absent and every operation resolves to the platform floor: an override may
  // only ever TIGHTEN, so having none is the strict end, not a fail-open default.
  const stepUpOverrides = deps.stepUpOverrides ?? (deps.db ? createDrizzleStepUpOverrideStore(deps.db) : undefined);
  registerSeam("SessionContextResolver", createSessionContextResolver(sessions, stepUpOverrides));
  registerSeam("AuditorSessionMinter", createAuditorSessionMinter(auditorLinks));
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
    registerSeam("TenantOrgCreationProvider", createTenantOrgCreationProvider(organizationDb));
    // M35A-T03 — the real org display-metadata reader M35's platform-ops admin lists label rows through
    // (the registry's graceful deny-stub, which resolves no names, stands in slice/tests without a db).
    registerSeam("OrganizationReader", createOrganizationReader(organizationDb));
  }
}
