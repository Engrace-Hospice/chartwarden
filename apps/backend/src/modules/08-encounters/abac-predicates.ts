// apps/backend/src/modules/08-encounters/abac-predicates.ts — M8-T09 (§4.6).
//
// The TWO named ABAC predicate resolvers M8 OWNS and registers into M3's named-predicate registry
// (M3 §3.4): `cosigner_role_match` and `encounter.scope`. Both are evaluated server-side AFTER RBAC
// passes; M8 never authorizes by reading the request body for a resource-bound predicate — the
// encounter's owner facts (patient/author/discipline) are loaded through the injected
// `EncounterAbacResolver` (org-scoped, RLS-backstopped). The §4.6 cosign rule: a cosigner must be an
// RN and must NOT be the encounter's original author (no self-cosign).
//
// GAP-014 (2026-08-09): this file's header USED TO say caseload membership was "composed separately by
// the reused `caseload_membership` predicate upstream" — but no route anywhere ever composed it; the
// module shipped with caseload scoping completely unenforced beyond org-level RBAC. `caseload_membership`
// (M5) and `caseload_or_scope` (M7) are both real, both registered — but neither is directly reusable
// here: `requireAbac`'s `getTarget` is SYNCHRONOUS (no DB lookup), and every M8 child route (vitals/
// mileage/care-plan-links/cosignature/addenda) carries `encounterId` in its path, not `patientId` — so
// composing either shared predicate by name would either not recognize the target field at all (silently
// ALLOWING everyone — worse than the gap it's meant to close) or require an async resolve `getTarget`
// can't do. Mirrors M6's `admission.scope` fix (GAP-011): an M8-owned `encounter.scope` predicate whose
// evaluator does the async encounterId→patientId resolve internally, then composes the SAME
// CaseloadProvider seam `caseload_membership`/`caseload_or_scope` both read. Deliberately does not
// preserve the spec's strict-membership-vs-loose-scope split (some routes name `caseload_membership`,
// others `caseload_or_scope`) — ONE composition (org-wide role escape ∨ caseload) is used everywhere,
// same simplification GAP-011/GAP-012 made for M6/M7.
//
// The spec's illustrative predicate reads `ctx.callerDisciplines()` / `ctx.callerMembershipId`; the real
// `AbacContext` (M3-T05) carries the server-assembled `roles` + `userId` instead, so the resolver derives
// the RN discipline from the actor's roles/attributes (the M7 `disciplineScopeOf` convention) and compares
// `context.userId` to the encounter's `authoredByUserId`. Registration is idempotent: the shared registry
// is single-owner / no-clear, so re-boot (tests) is idempotent via `registerPredicateIdempotent`.
import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@wardenx/auth";
import { getSeam } from "../../bootstrap/index";
import type { EncounterAbacResolver } from "./routes/service";

/**
 * The §4.6 predicate names M8 owns (registered into M3). `m8.cosigner_role_match` is namespaced —
 * M8/M9/M11 each define a `cosigner_role_match` with DIFFERENT target-field expectations (`encounterId`
 * vs `id`/`assessmentId` vs `id`/`orderId`); a shared bare name meant whichever module booted first
 * silently won the registration and the other two's cosign checks were quietly replaced by a resolver
 * that could never find its target field — always denying, with no error anywhere (ARCH-001/002).
 * `encounter.scope` (GAP-014) follows M6's `admission.scope` naming instead — module-qualified by
 * position, not prefix, since only M8 routes ever name it. Single-owner across the platform registry.
 */
export const M8_ABAC_PREDICATES = ["m8.cosigner_role_match", "encounter.scope"] as const;

/** Roles that read/scope any patient's encounters without caseload (mirrors M7's `caseload_or_scope`). */
const ORG_WIDE_SCOPE_ROLES = ["medical_director", "compliance_officer", "survey_coordinator"] as const;

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

/** Deps for M8's ABAC predicate resolvers (the slice injects an in-memory resolver over its dataset). */
export interface EncounterAbacDeps {
  /** Loads an encounter's org-scoped owner facts (in-memory in the slice; Drizzle in prod under RLS). */
  readonly resolver: EncounterAbacResolver;
  /** Caseload membership check (defaults to the boot-registered M5 `CaseloadProvider` seam). */
  readonly isInCaseload?: (q: {
    organizationId: string;
    userId: string;
    patientId: string;
  }) => Promise<boolean>;
}

/**
 * Build M8's two §4.6 predicate resolvers over injected deps (pure factory — unit-tested with a fresh
 * registry; the boot path registers them via {@link registerEncounterAbacPredicates}). `encounter.scope`'s
 * target reads `patientId` (the create route, lifted from the body — patientId is the SUBJECT being
 * authored, never trusted for anything else) or `encounterId` (every other route's own path param,
 * resolved to its patient via the resolver); a missing/cross-tenant encounter fails closed (deny).
 */
export function buildEncounterAbacPredicates(
  deps: EncounterAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  const isInCaseload = deps.isInCaseload ?? ((q) => getSeam("CaseloadProvider").isInCaseload(q));

  const caseloadOrScopeFor = async (context: AbacContext, patientId: string): Promise<boolean> => {
    if (ORG_WIDE_SCOPE_ROLES.some((r) => hasRole(context, r))) return true;
    if (!context.userId) return false;
    return isInCaseload({ organizationId: context.organizationId, userId: context.userId, patientId });
  };

  return {
    "m8.cosigner_role_match": async (context, target) => {
      if (!isRn(context)) return false; // a cosigner must be an RN (§4.6)
      const id = targetId(target, "encounterId");
      if (!id) return false;
      const facts = await resolver.loadEncounter(context.organizationId, id);
      if (!facts) return false; // fail-closed (absent / cross-tenant)
      // No self-cosign: the cosigner must not be the encounter's original author (§4.6).
      return facts.authoredByUserId !== context.userId;
    },
    "encounter.scope": async (context, target) => {
      const patientId = targetId(target, "patientId");
      if (patientId) return caseloadOrScopeFor(context, patientId);

      const encounterId = targetId(target, "encounterId");
      if (encounterId) {
        const facts = await resolver.loadEncounter(context.organizationId, encounterId);
        if (!facts) return false; // fail-closed (absent / cross-tenant)
        return caseloadOrScopeFor(context, facts.patientId);
      }

      return false; // no id at all — every wired route names one; fail closed on a misconfiguration.
    },
  };
}

/**
 * Register M8's §4.6 ABAC predicate resolvers into M3's shared registry (M8-T09; idempotent). Call at
 * boot after the encounter route service is constructed (the resolver reads the same dataset) and after
 * M5's `CaseloadProvider` seam registers (`encounter.scope` resolves through it by default). Re-boot
 * (tests) skips already-registered names (single-owner / no-clear).
 */
export function registerEncounterAbacPredicates(deps: EncounterAbacDeps): void {
  const predicates = buildEncounterAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
