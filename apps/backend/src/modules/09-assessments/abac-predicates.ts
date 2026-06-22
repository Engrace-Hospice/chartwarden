// apps/backend/src/modules/09-assessments/abac-predicates.ts — M9-T05 (§4.7).
//
// The TWO named ABAC predicate resolvers M9 OWNS and registers into M3's named-predicate registry (M3
// §3.4). Each is a typed `(context, target) => boolean` evaluated server-side AFTER RBAC passes:
//
//   discipline_can_record_scale[:scaleType] — D8 typed matrix (@wardenx/assessments eligibility): does ANY
//        of the caller's session-assembled disciplines cover the scale being recorded? The target's
//        `scaleType` is lifted from the request body (the thing being authored) by the author/correction
//        route's `getTarget`; the SUBJECT (the caller's discipline set) is never read from the body. A
//        discipline NOT in the scale's list is a structural floor — break-glass cannot grant it (§6).
//   cosigner_role_match                     — the §7.4 LPN-cosignature predicate: a cosigner must be an RN
//        or Clinical Supervisor AND must NOT be the row's original recorder (no self-cosign). The row's
//        recorder facts load through the injected `AssessmentAbacResolver` (org-scoped, RLS-backstopped);
//        a missing / cross-tenant row fails closed (deny).
//
// The §4.7 `sud_disclosure_allowed` / `dpoa_active` predicates are SHARED (registered by M5/M7, resolving
// through M39's `ConsentEvaluator` seam — the Part 2 / DPOA gate M9 binds by USING those names at the route,
// not by re-registering them). `caseload_or_scope` / `collaborator_patient_match` / `portal_patient_match`
// are likewise shared. Registration is idempotent: the shared registry is single-owner / no-clear, so
// re-boot (tests) guards on `abacRegistry.has`.
import { anyDisciplineCanRecordScale, ASSESSMENT_DISCIPLINES } from "@wardenx/assessments";
import { type AbacContext, type AbacTarget, abacRegistry, registerPredicate } from "@wardenx/auth";
import type { ScaleType } from "@wardenx/types";
import type { AssessmentAbacResolver } from "./routes/service";

/** The §4.7 predicate names M9 owns (registered into M3). Single-owner across the platform registry. */
export const M9_ABAC_PREDICATES = ["discipline_can_record_scale", "cosigner_role_match"] as const;

/** The disciplines that may attest an assessment cosignature (§6 `assessment.cosign`; lower-case keys). */
const COSIGN_ELIGIBLE_DISCIPLINES = ["rn", "rn_case_manager", "clinical_supervisor"] as const;

const hasRole = (context: AbacContext, role: string): boolean => context.roles.includes(role);
const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** Assemble the actor's discipline set from session roles/attributes (never client input). */
export function disciplinesOf(context: AbacContext): readonly string[] {
  const fromAttributes = Array.isArray(context.attributes.disciplines)
    ? context.attributes.disciplines.filter((x): x is string => typeof x === "string")
    : [];
  const fromRoles = context.roles.filter((r) => (ASSESSMENT_DISCIPLINES as readonly string[]).includes(r));
  return [...new Set([...fromAttributes, ...fromRoles])];
}

/** Whether the actor holds a cosign-eligible role/discipline (RN / RN Case Manager / Clinical Supervisor). */
function isCosignEligible(context: AbacContext): boolean {
  if (COSIGN_ELIGIBLE_DISCIPLINES.some((r) => hasRole(context, r))) return true;
  return disciplinesOf(context).some((d) => (COSIGN_ELIGIBLE_DISCIPLINES as readonly string[]).includes(d));
}

/** Deps for M9's ABAC predicate resolvers (the slice injects an in-memory resolver over its dataset). */
export interface AssessmentAbacDeps {
  /** Loads an assessment's org-scoped recorder facts (in-memory in the slice; Drizzle in prod under RLS). */
  readonly resolver: AssessmentAbacResolver;
}

/**
 * Build M9's two §4.7 predicate resolvers over injected deps (pure factory — unit-tested with a fresh
 * registry; the boot path registers them via {@link registerAssessmentAbacPredicates}). The author route's
 * target carries the body's `scaleType`; the cosign route's target carries the `:id` route param.
 */
export function buildAssessmentAbacPredicates(
  deps: AssessmentAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  return {
    discipline_can_record_scale: async (context, target) => {
      const scaleType = targetStr(target, "scaleType");
      if (!scaleType) return false; // no scale named → deny (fail-closed)
      return anyDisciplineCanRecordScale(disciplinesOf(context), scaleType as ScaleType);
    },
    cosigner_role_match: async (context, target) => {
      if (!isCosignEligible(context)) return false; // a cosigner must be RN / Clinical Supervisor (§7.4)
      const id = targetStr(target, "id") ?? targetStr(target, "assessmentId");
      if (!id) return false;
      const facts = await resolver.loadAssessment(context.organizationId, id);
      if (!facts) return false; // fail-closed (absent / cross-tenant)
      // No self-cosign: the cosigner must not be the row's original recorder (§7.4 / §6).
      return facts.recordedByUserId !== context.userId;
    },
  };
}

/**
 * Register M9's two §4.7 ABAC predicate resolvers into M3's shared registry (M9-T05; idempotent). Call at
 * boot after the assessment route service is constructed (the resolver reads the same dataset). Re-boot
 * (tests) skips already-registered names (single-owner / no-clear).
 */
export function registerAssessmentAbacPredicates(deps: AssessmentAbacDeps): void {
  const predicates = buildAssessmentAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    if (abacRegistry.has(name)) continue;
    registerPredicate(name, predicate);
  }
}
