// apps/backend/src/modules/07-care-plan/abac-predicates.ts — M7-T06 (§6 / §2.3).
//
// The FIVE named ABAC predicate resolvers M7 OWNS and registers into M3's named-predicate registry
// (M3 §3.4). Each is a typed `(context, target) => boolean` evaluated server-side AFTER RBAC passes;
// M7 never authorizes by reading the request body for the resource-bound predicates — the resource's
// owner facts are loaded through the injected `CarePlanAbacResolver` (org-scoped, RLS-backstopped).
// `discipline_scope` is the one predicate whose target is the body's `discipline` (the thing being
// authored): `requireAbac`'s `getTarget` lifts it from the request, and the predicate compares it to
// the actor's session-assembled discipline scope — still never trusting the body for the SUBJECT.
//
//   caseload_or_scope      — caller's caseload covers the plan's patient, OR an org-wide scope role,
//                            OR a session scope (collaborator/portal) naming the patient.
//   dpoa_active            — an active `dpoa_healthcare` consent exists for the plan's patient (M39).
//   sud_disclosure_allowed — per-problem: not SUD, OR a satisfied `42_cfr_part_2_release` context (M39),
//                            OR the assigned RN Case Manager (§7.6).
//   signer_role_match      — caller's eligible signer roles intersect the version's RequiredSignerSet.
//   discipline_scope       — the intervention's discipline matches the caller's (IDG Coordinator excepted).
//
// Consent (`dpoa_active`, `sud_disclosure_allowed`) resolves through M39's `ConsentEvaluator` seam; M7
// `dependsOn` 39, so it imports the TYPE from @wardenx/consent and resolves the impl via the opaque M1
// registry (`getSeam`). Registration is idempotent: the shared registry is single-owner / no-clear, so
// re-boot (tests) is idempotent via `registerPredicateIdempotent`.
import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@wardenx/auth";
import type { ConsentEvaluator, ConsentTypeKey } from "@wardenx/consent";
import type { CarePlanSignerRole } from "@wardenx/types";
import { getSeam } from "../../bootstrap/index";
import { IDG_COORDINATOR_ROLE, canAuthorInterventionDiscipline } from "./authoring/index";
import type { AuthoringDisciplineScope } from "./authoring/index";
import type { CarePlanAbacResolver } from "./routes/service";

/** The §6 predicate names M7 owns (registered into M3). Single-owner across the platform registry. */
export const M7_ABAC_PREDICATES = [
  "caseload_or_scope",
  "dpoa_active",
  "sud_disclosure_allowed",
  "signer_role_match",
  "discipline_scope",
] as const;

/** Roles that read the whole org's care plans without caseload (§6 `caseload_or_scope`). */
const ORG_WIDE_SCOPE_ROLES = [
  "medical_director",
  "compliance_officer",
  "survey_coordinator",
] as const;

/** The InterventionDiscipline tokens a role key directly names (used to assemble the actor's scope). */
const DISCIPLINE_ROLE_TOKENS = [
  "rn",
  "lpn",
  "chha",
  "msw",
  "chaplain",
  "md_np",
  "pt",
  "ot",
  "st",
  "volunteer",
  "music_therapy",
  "dietitian",
  "bereavement",
] as const;

const hasRole = (context: AbacContext, role: string): boolean => context.roles.includes(role);
const targetId = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** Patient ids a collaborator/portal session is scoped to (assembled server-side onto `attributes`). */
function sessionScopePatientIds(context: AbacContext): readonly string[] {
  const raw = context.attributes.scopePatientIds;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

/** Assemble the actor's §7.4 discipline scope from session roles/attributes (never client input). */
export function disciplineScopeOf(context: AbacContext): AuthoringDisciplineScope {
  const fromAttributes = Array.isArray(context.attributes.disciplines)
    ? context.attributes.disciplines.filter((x): x is string => typeof x === "string")
    : [];
  const fromRoles = context.roles.filter((r) =>
    (DISCIPLINE_ROLE_TOKENS as readonly string[]).includes(r),
  );
  const disciplines = [
    ...new Set([...fromAttributes, ...fromRoles]),
  ] as AuthoringDisciplineScope["disciplines"];
  return { disciplines, isIdgCoordinator: hasRole(context, IDG_COORDINATOR_ROLE) };
}

/** The signer roles a `care_plan_signature` may be captured under (mirrors `CarePlanSignerRole`). */
const SIGNER_ROLE_KEYS: readonly CarePlanSignerRole[] = [
  "rn_case_manager",
  "hospice_physician",
  "nurse_practitioner",
  "msw",
  "chaplain",
  "medical_director",
];

/** Deps for M7's ABAC predicate resolvers (the slice injects an in-memory resolver + seam stubs). */
export interface CarePlanAbacDeps {
  /** Loads a plan/problem/version's org-scoped owner facts (in-memory in the slice; Drizzle in prod). */
  readonly resolver: CarePlanAbacResolver;
  /** Caseload membership check (defaults to the boot-registered M5 `CaseloadProvider` seam). */
  readonly isInCaseload?: (q: {
    organizationId: string;
    userId: string;
    patientId: string;
  }) => Promise<boolean>;
  /** Active-consent check (defaults to M39's `ConsentEvaluator` seam; fail-closed on absence). */
  readonly isConsentActive?: (q: {
    organizationId: string;
    patientId: string;
    consentType: ConsentTypeKey;
  }) => Promise<boolean>;
}

/**
 * Build M7's five §6 predicate resolvers over injected deps (pure factory — unit-tested with a fresh
 * registry; the boot path registers these into the shared registry via {@link registerCarePlanAbacPredicates}).
 */
export function buildCarePlanAbacPredicates(
  deps: CarePlanAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  const isInCaseload = deps.isInCaseload ?? ((q) => getSeam("CaseloadProvider").isInCaseload(q));
  const isConsentActive =
    deps.isConsentActive ??
    (async (q) => {
      const evaluator = getSeam("ConsentEvaluator") as ConsentEvaluator;
      const res = await evaluator.evaluate({
        organizationId: q.organizationId,
        patientId: q.patientId,
        consentType: q.consentType,
        sessionContext: { sessionClass: "staff" },
        callerModule: "m7",
      });
      return res.allowed;
    });

  /** Caseload-or-scope over a patient: org-wide role, session scope, or caseload membership. */
  const caseloadOrScopeFor = async (context: AbacContext, patientId: string): Promise<boolean> => {
    if (ORG_WIDE_SCOPE_ROLES.some((r) => hasRole(context, r))) return true;
    if (sessionScopePatientIds(context).includes(patientId)) return true;
    if (!context.userId) return false;
    return isInCaseload({
      organizationId: context.organizationId,
      userId: context.userId,
      patientId,
    });
  };

  return {
    // SHARED predicate: nine modules (M9-M15, M19-M26, M34) bind this name, and `caseload_or_scope`
    // is a PATIENT-scope concept, not an M7-row concept. Keying it solely on M7's `planId` made it
    // deny for every consumer that names a patient or a collection — the M15-T06 dead-gate class.
    // Three target shapes, in the order a consumer can supply them:
    //   1. `patientId`   — the caseload subject itself (M19/M20/M23 and the other by-name binders).
    //   2. `planId`      — M7's own row, resolved to its patient (fail-closed if absent/cross-tenant).
    //   3. `{}`          — a COLLECTION route: no row named yet. Per M3's `inOrg` doc-comment this is
    //                      the precondition case — the predicate asserts an org-scoped actor and RLS
    //                      plus the read service's own narrowing are the row control.
    caseload_or_scope: async (context, target) => {
      const patientId = targetId(target, "patientId");
      if (patientId) return caseloadOrScopeFor(context, patientId);

      const planId = targetId(target, "planId");
      if (planId) {
        const facts = await resolver.loadPlan(context.organizationId, planId);
        if (!facts) return false; // fail-closed (absent / cross-tenant)
        return caseloadOrScopeFor(context, facts.patientId);
      }

      return Boolean(context.organizationId) && Boolean(context.userId);
    },
    dpoa_active: async (context, target) => {
      const id = targetId(target, "planId");
      if (!id) return false;
      const facts = await resolver.loadPlan(context.organizationId, id);
      if (!facts) return false;
      return isConsentActive({
        organizationId: context.organizationId,
        patientId: facts.patientId,
        consentType: "dpoa_healthcare",
      });
    },
    sud_disclosure_allowed: async (context, target) => {
      const id = targetId(target, "elementId") ?? targetId(target, "problemId");
      if (!id) return false;
      const facts = await resolver.loadProblem(context.organizationId, id);
      if (!facts) return false;
      if (!facts.sudRelated) return true; // §7.6: non-SUD problems are unrestricted
      if (hasRole(context, "rn_case_manager")) return true; // the assigned RN Case Manager (§7.6)
      return isConsentActive({
        organizationId: context.organizationId,
        patientId: facts.patientId,
        consentType: "42_cfr_part_2_release",
      });
    },
    signer_role_match: async (context, target) => {
      const id = targetId(target, "versionId");
      if (!id) return false;
      const facts = await resolver.loadVersion(context.organizationId, id);
      if (!facts) return false;
      const eligible = SIGNER_ROLE_KEYS.filter((r) => hasRole(context, r));
      if (eligible.length === 0) return false;
      // True iff the caller can satisfy at least one slot (a `|`-union slot needs any one member).
      return facts.requiredSignerSet.some((slot) =>
        slot.role
          .split("|")
          .some((roleToken) => eligible.includes(roleToken as CarePlanSignerRole)),
      );
    },
    discipline_scope: async (context, target) => {
      const discipline = targetId(target, "discipline");
      if (!discipline) return false;
      return canAuthorInterventionDiscipline(
        disciplineScopeOf(context),
        discipline as AuthoringDisciplineScope["disciplines"][number],
      );
    },
  };
}

/**
 * Register M7's five §6 ABAC predicate resolvers into M3's shared registry (M7-T06; idempotent).
 * Call at boot after the M5 `CaseloadProvider` and M39 `ConsentEvaluator` seams are registered
 * (caseload/consent predicates resolve through them). Re-boot (tests) skips already-registered names.
 */
export function registerCarePlanAbacPredicates(deps: CarePlanAbacDeps): void {
  const predicates = buildCarePlanAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
