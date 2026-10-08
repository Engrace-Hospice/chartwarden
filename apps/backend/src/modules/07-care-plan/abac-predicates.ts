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
//   sud_disclosure_allowed — per-problem: not SUD, OR the PER-ACTOR `42_cfr_part_2_release` verdict
//                            (M39 `evaluateForInternalAccess`), OR — only when the release does not
//                            name other workforce members — the RN Case Manager (§7.6).
//   signer_role_match      — caller's eligible signer roles intersect the version's RequiredSignerSet.
//   discipline_scope       — the intervention's discipline matches the caller's (IDG Coordinator excepted).
//
// Consent (`dpoa_active`, `sud_disclosure_allowed`) resolves through M39's `ConsentEvaluator` seam; M7
// `dependsOn` 39, so it imports the TYPE from @wardenx/consent and resolves the impl via the opaque M1
// registry (`getSeam`). Registration is idempotent: the shared registry is single-owner / no-clear, so
// re-boot (tests) is idempotent via `registerPredicateIdempotent`.
import {
  type AbacContext,
  type AbacTarget,
  hasOrgWideScope,
  registerPredicateIdempotent,
} from "@wardenx/auth";
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

/**
 * The patient a collaborator / funeral / portal session is pinned to (server-assembled, §3.6 `scope`).
 *
 * This read used to be `attributes.scopePatientIds`, an ARRAY — a third name for a fact M31 and M19
 * were reading as `portalPatientId` and `patientId`, and that nothing wrote under any of them, so
 * `caseload_or_scope`'s session-scope arm never once fired and every collaborator fell through to the
 * caseload lookup they are not in (F-030). A session pins exactly ONE patient — that is what the
 * `session_scope_chk` CHECK enforces and what `sessionPinnedPatientId` returns — so the plural was
 * never true either: an empty-or-one array dressed up as a set.
 */
function sessionScopePatientId(context: AbacContext): string | null {
  const raw = context.attributes.sessionPatientId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** A consent-type checker matching {@link CarePlanAbacDeps.isConsentActive}'s shape. */
type ConsentActiveChecker = (q: {
  organizationId: string;
  patientId: string;
  consentType: ConsentTypeKey;
}) => Promise<boolean>;

/**
 * The default `isConsentActive` implementation — resolves through M39's `ConsentEvaluator` seam.
 * Exported so GAP-013's route-level `dpoaConsentActive`/`sudDisclosureAllowed` closures (M7-T05's
 * `mountCarePlanRoutes`) can reuse the SAME seam glue this module's predicates use, rather than a
 * second, divergent copy.
 */
export function defaultConsentActiveChecker(): ConsentActiveChecker {
  return async (q) => {
    const evaluator = getSeam("ConsentEvaluator") as ConsentEvaluator;
    const res = await evaluator.evaluate({
      organizationId: q.organizationId,
      patientId: q.patientId,
      consentType: q.consentType,
      sessionContext: { sessionClass: "staff" },
      callerModule: "m7",
    });
    return res.allowed;
  };
}

/** M39's verdict on one actor's Part 2 access, reduced to the two facts §7.6 needs. */
export interface InternalSudVerdict {
  /** May THIS actor see the patient's SUD content, on the strength of the consent record alone? */
  readonly allowed: boolean;
  /**
   * The patient's release names workforce members and this actor is not one of them (or could not be
   * identified). Distinct from `!allowed`, which is also true when there is simply NO release on file:
   * only this flag means the patient made a deliberate, per-person restriction, and only this flag
   * outranks the §7.6 role path below.
   */
  readonly restrictedToNamedWorkforce: boolean;
}

/** The per-actor Part 2 checker `sud_disclosure_allowed` resolves through (M39 `evaluateForInternalAccess`). */
export type InternalSudAccessChecker = (q: {
  organizationId: string;
  patientId: string;
  /** The actor's ACTIVE M2 membership id — the id space `consent_record_recipient` names a
   *  `workforce_member` with. `null` when the session carries none. */
  membershipId: string | null;
}) => Promise<InternalSudVerdict>;

/**
 * The default `sud_disclosure_allowed` backing — M39's `evaluateForInternalAccess`, the PER-ACTOR Part 2
 * decision. Exported for the same reason `defaultConsentActiveChecker` is: the route-level redaction
 * closure must reuse this exact glue rather than a second, divergent copy.
 *
 * Fail-CLOSED on any seam error, and fail-closed in BOTH fields — an M39 outage must not be readable as
 * "no restriction exists", which would hand the §7.6 role path a disclosure the consent record might
 * forbid.
 */
export function defaultInternalSudAccessChecker(): InternalSudAccessChecker {
  return async (q) => {
    try {
      const evaluator = getSeam("ConsentEvaluator") as ConsentEvaluator;
      const res = await evaluator.evaluateForInternalAccess({
        organizationId: q.organizationId,
        patientId: q.patientId,
        actor: { membershipId: q.membershipId },
        callerModule: "m7",
      });
      return {
        allowed: !res.redactSubstanceUseDisorderFields,
        restrictedToNamedWorkforce:
          res.basis === "release_names_others" || res.basis === "actor_unidentified",
      };
    } catch {
      return { allowed: false, restrictedToNamedWorkforce: true };
    }
  };
}

/** The actor's active membership id off the M2-assembled session attributes (never the request body). */
export function membershipIdOf(context: AbacContext): string | null {
  const raw = context.attributes.membershipId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/**
 * §7.6 SUD disclosure, at PATIENT scope. Shared by the per-problem `sud_disclosure_allowed` predicate
 * below (which additionally short-circuits true for a non-SUD problem before reaching this) and by
 * the route-level per-read redaction closure (GAP-013's `mountCarePlanRoutes`, which has no single
 * problem in view — a whole plan/summary read is redacted uniformly, non-SUD problems unaffected).
 *
 * This is THE `sud_disclosure_allowed` resolver — M8, M9, M11, M12, M13, M14, M15, M22 and M28 all
 * bind the name M7 registers — so it is where "recipient matches the requesting party" (§6.4) has to
 * become true. It used to ask M39 the PATIENT-scope question ("is a `42_cfr_part_2_release` on file
 * for this patient at all?") because that was the only question M39 could answer about an internal
 * caller: every recipient class was external. `workforce_member` (mig 0209) closed that, so the call
 * is now `evaluateForInternalAccess` and the answer is about the actor.
 *
 * ORDER MATTERS, and it is the reverse of what it was. The RN-Case-Manager path is a TREATMENT
 * carve-out — an intra-program communication is not a §2.31 disclosure (42 CFR §2.12(c)(3)) — so it
 * still lets a case manager read a chart with no release on file. What it may NOT do is override a
 * release the patient deliberately restricted to named workforce members: that restriction exists
 * precisely to exclude other staff, and a role key cannot outrank the patient who signed it. So M39 is
 * consulted FIRST (one extra round-trip on the case-manager path, which is the price of knowing
 * whether a restriction exists) and the role path only applies when no restriction names someone else.
 */
export async function sudDisclosureAllowedForPatient(
  context: AbacContext,
  patientId: string,
  checkInternalAccess: InternalSudAccessChecker,
): Promise<boolean> {
  const verdict = await checkInternalAccess({
    organizationId: context.organizationId,
    patientId,
    membershipId: membershipIdOf(context),
  });
  if (verdict.allowed) return true;
  return !verdict.restrictedToNamedWorkforce && hasRole(context, "rn_case_manager");
}

/**
 * Assemble the actor's §7.4 discipline scope from the session ROLE KEYS (never client input).
 *
 * WHY ROLE KEYS AND NOT A WORKFORCE READ — the platform's one derivation, stated in three places and now
 * followed in all of them. M19's `TRIAGE_DISCIPLINE_FOR_ROLE_KEY` puts it plainly ("M3's
 * `RoleGrant.roleKey` is the platform's one authority-derivation input"), and M17 — which OWNS the
 * discipline vocabulary AND the `membership_credential` table — resolves its own D8 pre-schedule gate
 * exactly this way (`resolveDisciplinesTx`: active role grants ∩ the scheduling-discipline vocabulary).
 * M17 reads the credential for a DIFFERENT and deliberately orthogonal question — is the licence active —
 * because a clinician can hold the `rn` role while their nursing licence has lapsed. Authority comes from
 * the grant; the credential says whether it is currently exercisable.
 *
 * THIS USED TO UNION IN AN `attributes.disciplines` ARRAY FIRST, and so did the same derivation in M8, M9,
 * M10, M11, M12 and M13 — seven modules, seven copies, one key that no producer in the platform has ever
 * written. The union was therefore with the empty set on every request ever served: the role arm has been
 * the entire answer everywhere, all along. It degraded instead of dying, which is why it went unnoticed
 * for the whole life of the codebase (F-030). Seven dead reads standing in front of the derivation that
 * actually answers is the one arrangement that could not stay — either the fact gets produced or the reads
 * go, and producing an EIGHTH answer to a question three modules already answer identically would have
 * been the drift, not the fix.
 */
export function disciplineScopeOf(context: AbacContext): AuthoringDisciplineScope {
  const disciplines = context.roles.filter((r) =>
    (DISCIPLINE_ROLE_TOKENS as readonly string[]).includes(r),
  ) as AuthoringDisciplineScope["disciplines"];
  return {
    disciplines: [...new Set(disciplines)] as AuthoringDisciplineScope["disciplines"],
    isIdgCoordinator: hasRole(context, IDG_COORDINATOR_ROLE),
  };
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
  /**
   * The PER-ACTOR Part 2 check `sud_disclosure_allowed` resolves through (defaults to M39's
   * `evaluateForInternalAccess`). Separate from {@link isConsentActive} because it asks a different
   * question — "may THIS actor see it", not "does a consent of this type exist" — and answering the
   * first with the second is exactly what this predicate used to do.
   */
  readonly sudInternalAccess?: InternalSudAccessChecker;
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
  const isConsentActive = deps.isConsentActive ?? defaultConsentActiveChecker();
  const sudInternalAccess = deps.sudInternalAccess ?? defaultInternalSudAccessChecker();

  /** Caseload-or-scope over a patient: org-wide role, session scope, or caseload membership. */
  const caseloadOrScopeFor = async (context: AbacContext, patientId: string): Promise<boolean> => {
    if (hasOrgWideScope(context.roles)) return true;
    if (sessionScopePatientId(context) === patientId) return true;
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
      return sudDisclosureAllowedForPatient(context, facts.patientId, sudInternalAccess);
    },
    signer_role_match: async (context, target) => {
      const id = targetId(target, "versionId");
      if (!id) return false;
      const facts = await resolver.loadVersion(context.organizationId, id);
      if (!facts) return false;
      const eligible = SIGNER_ROLE_KEYS.filter((r) => hasRole(context, r));
      if (eligible.length === 0) return false;
      // GAP-011: when the sign attempt names the slot it claims, the caller must hold THAT role.
      const claimed = targetId(target, "signerRole");
      if (claimed !== null && !eligible.includes(claimed as CarePlanSignerRole)) return false;
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
