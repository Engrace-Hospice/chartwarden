// apps/backend/src/modules/08-encounters/abac-predicates.ts — M8-T09 (§4.6).
//
// The ONE named ABAC predicate resolver M8 OWNS and registers into M3's named-predicate registry
// (M3 §3.4): `cosigner_role_match`. It is evaluated server-side AFTER RBAC passes; M8 never authorizes
// by reading the request body — the encounter's owner facts (author + discipline) are loaded through the
// injected `EncounterAbacResolver` (org-scoped, RLS-backstopped). The §4.6 rule: a cosigner must be an
// RN and must NOT be the encounter's original author (no self-cosign). Caseload membership is composed
// separately by the reused `caseload_membership` predicate upstream (§4.6), so it is not re-checked here.
//
// The spec's illustrative predicate reads `ctx.callerDisciplines()` / `ctx.callerMembershipId`; the real
// `AbacContext` (M3-T05) carries the server-assembled `roles` + `userId` instead, so the resolver derives
// the RN discipline from the actor's roles/attributes (the M7 `disciplineScopeOf` convention) and compares
// `context.userId` to the encounter's `authoredByUserId`. Registration is idempotent: the shared registry
// is single-owner / no-clear, so re-boot (tests) guards on `abacRegistry.has`.
import { type AbacContext, type AbacTarget, abacRegistry, registerPredicate } from "@wardenx/auth";
import type { EncounterAbacResolver } from "./routes/service";

/** The §4.6 predicate name M8 owns (registered into M3). Single-owner across the platform registry. */
export const M8_ABAC_PREDICATES = ["cosigner_role_match"] as const;

const hasRole = (context: AbacContext, role: string): boolean => context.roles.includes(role);
const targetId = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** Whether the actor holds the RN discipline (from role keys or the session-assembled discipline set). */
function isRn(context: AbacContext): boolean {
  if (hasRole(context, "rn") || hasRole(context, "rn_case_manager")) return true;
  const disciplines = context.attributes.disciplines;
  return Array.isArray(disciplines) && disciplines.includes("rn");
}

/** Deps for M8's ABAC predicate resolver (the slice injects an in-memory resolver over its dataset). */
export interface EncounterAbacDeps {
  /** Loads an encounter's org-scoped owner facts (in-memory in the slice; Drizzle in prod under RLS). */
  readonly resolver: EncounterAbacResolver;
}

/**
 * Build M8's §4.6 `cosigner_role_match` resolver over injected deps (pure factory — unit-tested with a
 * fresh registry; the boot path registers it via {@link registerEncounterAbacPredicates}). The target's
 * `encounterId` is the route param; a missing/cross-tenant encounter fails closed (deny).
 */
export function buildEncounterAbacPredicates(
  deps: EncounterAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  return {
    cosigner_role_match: async (context, target) => {
      if (!isRn(context)) return false; // a cosigner must be an RN (§4.6)
      const id = targetId(target, "encounterId");
      if (!id) return false;
      const facts = await resolver.loadEncounter(context.organizationId, id);
      if (!facts) return false; // fail-closed (absent / cross-tenant)
      // No self-cosign: the cosigner must not be the encounter's original author (§4.6).
      return facts.authoredByUserId !== context.userId;
    },
  };
}

/**
 * Register M8's §4.6 ABAC predicate resolver into M3's shared registry (M8-T09; idempotent). Call at boot
 * after the encounter route service is constructed (the resolver reads the same dataset). Re-boot (tests)
 * skips already-registered names (single-owner / no-clear).
 */
export function registerEncounterAbacPredicates(deps: EncounterAbacDeps): void {
  const predicates = buildEncounterAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    if (abacRegistry.has(name)) continue;
    registerPredicate(name, predicate);
  }
}
