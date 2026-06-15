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
  createAuditorSessionMinter,
  createInMemoryAuditorMagicLinkIssuer,
  createInMemorySessionContextStore,
  createSessionContextResolver,
} from "@wardenx/auth";
import { registerSeam } from "../../bootstrap/index";

/** Injected production adapters for M2's published seams (slice defaults to in-memory). */
export interface IdentitySeamDeps {
  /** Reads session context rows by id within an org scope (M1 `session` repo in production). */
  sessions?: SessionContextStore;
  /** Mints the one-time auditor magic-link token (Valkey TTL store in production). */
  auditorLinks?: AuditorMagicLinkIssuer;
}

/** Register M2's published seams into the M1 registry (M2-T07; call before validateSeams()). */
export function registerIdentitySeams(deps: IdentitySeamDeps = {}): void {
  const sessions = deps.sessions ?? createInMemorySessionContextStore().store;
  const auditorLinks = deps.auditorLinks ?? createInMemoryAuditorMagicLinkIssuer().issuer;
  registerSeam("SessionContextResolver", createSessionContextResolver(sessions));
  registerSeam("AuditorSessionMinter", createAuditorSessionMinter(auditorLinks));
}
