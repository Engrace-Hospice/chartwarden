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
// not by re-registering them). `caseload_or_scope` (registered by M7) is likewise shared and bound DIRECTLY
// by name on the 9 M9 routes that already carry `patientId` in their own path params — the shared
// predicate's own target-shape contract (patientId / a row id it can resolve / `{}`) recognizes bare
// `patientId` with the DEFAULT synchronous `getTarget`, no M9 wrapper needed there. `collaborator_patient_
// match` / `portal_patient_match` are unregistered anywhere in the platform (no module owns them); per the
// M7 GAP-012 precedent, `caseload_or_scope`'s own session-scope branch already covers the collaborator/
// portal-session case the OR clause names, so the summary route (§4.1) also binds `caseload_or_scope`
// directly rather than composing a second predicate that resolves to nothing.
//
// GAP-015 (2026-08-09): that leaves TWO routes whose only id is NOT `patientId` — `POST
// /assessments/:id/cosignatures` (an assessmentId) and `POST /significant-changes/:eventId/acknowledge`
// (an eventId) — `requireAbac`'s `getTarget` is synchronous, so the shared predicate can't resolve either
// by name (M6/M8 precedent: composing it anyway would silently ALLOW everyone). This file adds a THIRD,
// M9-owned predicate, `assessment.scope`, whose evaluator does the async id→patientId resolve internally
// (via `AssessmentAbacResolver.loadAssessment` / the new `loadSignificantChangeEvent`), then applies the
// SAME org-wide-role-escape ∨ caseload composition `caseload_or_scope` uses — duplicated locally rather
// than shared cross-module, matching the GAP-011/012/014 precedent (each module's copy stays a few lines).
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests) is
// idempotent via `registerPredicateIdempotent`.
import { ASSESSMENT_DISCIPLINES, anyDisciplineCanRecordScale } from "@wardenx/assessments";
import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@wardenx/auth";
import type { ScaleType } from "@wardenx/types";
import { getSeam } from "../../bootstrap/index";
import type { AssessmentAbacResolver } from "./routes/service";

/**
 * The §4.7/§4.1 predicate names M9 owns (registered into M3). `cosigner_role_match` is namespaced `m9.` —
 * M8/M9/M11 each define one with DIFFERENT target-field expectations; a shared bare name meant whichever
 * module booted first silently won the registration and the other two's cosign checks were quietly
 * replaced by a resolver that could never find its target field — always denying, with no error anywhere
 * (ARCH-001/002). `assessment.scope` (GAP-015) follows M6/M8's `admission.scope`/`encounter.scope` naming
 * instead — module-qualified by position, not prefix, since only M9 routes ever name it. Single-owner
 * across the platform registry.
 */
export const M9_ABAC_PREDICATES = [
  "discipline_can_record_scale",
  "m9.cosigner_role_match",
  "assessment.scope",
] as const;

/** The disciplines that may attest an assessment cosignature (§6 `assessment.cosign`; lower-case keys). */
const COSIGN_ELIGIBLE_DISCIPLINES = ["rn", "rn_case_manager", "clinical_supervisor"] as const;

/** Roles that read/scope any patient's assessments without caseload (mirrors M7/M8's `caseload_or_scope`). */
const ORG_WIDE_SCOPE_ROLES = [
  "medical_director",
  "compliance_officer",
  "survey_coordinator",
] as const;

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
  const fromRoles = context.roles.filter((r) =>
    (ASSESSMENT_DISCIPLINES as readonly string[]).includes(r),
  );
  return [...new Set([...fromAttributes, ...fromRoles])];
}

/** Whether the actor holds a cosign-eligible role/discipline (RN / RN Case Manager / Clinical Supervisor). */
function isCosignEligible(context: AbacContext): boolean {
  if (COSIGN_ELIGIBLE_DISCIPLINES.some((r) => hasRole(context, r))) return true;
  return disciplinesOf(context).some((d) =>
    (COSIGN_ELIGIBLE_DISCIPLINES as readonly string[]).includes(d),
  );
}

/** Deps for M9's ABAC predicate resolvers (the slice injects an in-memory resolver over its dataset). */
export interface AssessmentAbacDeps {
  /** Loads an assessment's org-scoped recorder facts (in-memory in the slice; Drizzle in prod under RLS). */
  readonly resolver: AssessmentAbacResolver;
  /** Caseload membership check (defaults to the boot-registered M5 `CaseloadProvider` seam). */
  readonly isInCaseload?: (q: {
    organizationId: string;
    userId: string;
    patientId: string;
  }) => Promise<boolean>;
}

/**
 * Build M9's three predicate resolvers over injected deps (pure factory — unit-tested with a fresh
 * registry; the boot path registers them via {@link registerAssessmentAbacPredicates}). The author route's
 * target carries the body's `scaleType`; the cosign route's target carries the `:id` route param.
 * `assessment.scope`'s target reads `assessmentId`/`id` (the cosignatures route's own path param, resolved
 * to its patient) or `eventId` (the acknowledge route's own path param, resolved via its triggering
 * assessment) — the 9 routes that already carry `patientId` bind the SHARED `caseload_or_scope` directly
 * instead (see this file's header); a missing/cross-tenant row fails closed (deny).
 */
export function buildAssessmentAbacPredicates(
  deps: AssessmentAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  const isInCaseload = deps.isInCaseload ?? ((q) => getSeam("CaseloadProvider").isInCaseload(q));

  const caseloadOrScopeFor = async (context: AbacContext, patientId: string): Promise<boolean> => {
    if (ORG_WIDE_SCOPE_ROLES.some((r) => hasRole(context, r))) return true;
    if (!context.userId) return false;
    return isInCaseload({
      organizationId: context.organizationId,
      userId: context.userId,
      patientId,
    });
  };

  return {
    discipline_can_record_scale: async (context, target) => {
      const scaleType = targetStr(target, "scaleType");
      if (!scaleType) return false; // no scale named → deny (fail-closed)
      return anyDisciplineCanRecordScale(disciplinesOf(context), scaleType as ScaleType);
    },
    "m9.cosigner_role_match": async (context, target) => {
      if (!isCosignEligible(context)) return false; // a cosigner must be RN / Clinical Supervisor (§7.4)
      const id = targetStr(target, "id") ?? targetStr(target, "assessmentId");
      if (!id) return false;
      const facts = await resolver.loadAssessment(context.organizationId, id);
      if (!facts) return false; // fail-closed (absent / cross-tenant)
      // No self-cosign: the cosigner must not be the row's original recorder (§7.4 / §6).
      return facts.recordedByUserId !== context.userId;
    },
    "assessment.scope": async (context, target) => {
      const patientId = targetStr(target, "patientId");
      if (patientId) return caseloadOrScopeFor(context, patientId);

      const assessmentId = targetStr(target, "id") ?? targetStr(target, "assessmentId");
      if (assessmentId) {
        const facts = await resolver.loadAssessment(context.organizationId, assessmentId);
        if (!facts) return false; // fail-closed (absent / cross-tenant)
        return caseloadOrScopeFor(context, facts.patientId);
      }

      const eventId = targetStr(target, "eventId");
      if (eventId) {
        const event = await resolver.loadSignificantChangeEvent(context.organizationId, eventId);
        if (!event) return false; // fail-closed (absent / cross-tenant)
        return caseloadOrScopeFor(context, event.patientId);
      }

      return false; // no id at all — every wired route names one; fail closed on a misconfiguration.
    },
  };
}

/**
 * Register M9's three ABAC predicate resolvers into M3's shared registry (M9-T05/GAP-015; idempotent). Call
 * at boot after the assessment route service is constructed (the resolver reads the same dataset) and
 * after M5's `CaseloadProvider` seam registers (`assessment.scope` resolves through it by default).
 * Re-boot (tests) skips already-registered names (single-owner / no-clear).
 */
export function registerAssessmentAbacPredicates(deps: AssessmentAbacDeps): void {
  const predicates = buildAssessmentAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
