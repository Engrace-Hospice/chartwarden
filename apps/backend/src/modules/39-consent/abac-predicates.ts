// apps/backend/src/modules/39-consent/abac-predicates.ts — M39-T07 (spec §4.8).
//
// The SEVEN named ABAC predicate resolvers M39 OWNS and registers into M3's named-predicate
// registry at boot. These gate OTHER modules' routes by name (M8/M9/M11/M12/M13/M14/M17/M18/
// M19/M22/M28/M30/M33) — the consuming module writes `requireAbac('sud_consent_present', …)`
// and M3 resolves through the resolver registered here. Every resolver delegates to the published
// `ConsentEvaluator` seam (§4.3) so there is ONE decision engine; the predicate is a thin
// (patient, consentType) → allowed adapter. Registered once, idempotently (the registry is single-
// owner / no-clear, so re-boot in tests is idempotent via `registerPredicateIdempotent`).
//
// FOUR names this map does NOT carry, though the §4.8 spec text groups them with the rest, because a
// DIFFERENT module already registers a real, target-shape-specific resolver under that exact name —
// `registerPredicateIdempotent` now THROWS on a same-name-different-resolver collision (ARCH-001/002),
// so a generic (patientId|id)-shaped duplicate here would break boot, not just lose a silent race:
//   - `dpoa_active` / `sud_disclosure_allowed` — M7 (Care Plan) owns these, keyed on its OWN
//     `planId`/`elementId` targets (`apps/backend/src/modules/07-care-plan/abac-predicates.ts`).
//   - `family_violence_disclosure_allowed` — M15 (Discipline Care Plans) owns this one, composing a
//     role + session-class check on top of the same `ConsentEvaluator` seam
//     (`apps/backend/src/modules/15-discipline-care-plans/abac-predicates.ts`).
//   - `telehealth_consent_active` — M31 (Portal) owns this one, resolving the patient from the
//     target's `telehealthVisitId` via its own visit reader before consulting the same seam
//     (`apps/backend/src/modules/31-portal/abac-predicates.ts`).
// Before `registerPredicateIdempotent` existed, whichever of M39/M7/M15/M31 booted first silently won
// the registration (`if (abacRegistry.has(name)) continue;`) and the other's resolver never ran — for
// `dpoa_active`/`sud_disclosure_allowed` that meant M39 (boots first) silently discarded M7's real
// plan/problem-aware resolver in favor of a generic one nothing actually called by name (no route
// anywhere gates on the bare `dpoa_active`/`sud_disclosure_allowed` strings — M7/M9/M15 enforce them
// service-side instead, per M9's and M15's own guards.ts comments), so removing the dead duplicate here
// changes no runtime behavior; for `telehealth_consent_active` M31 boots first and IS consumed by name
// (`31-portal/routes/guards.ts`), so M39's copy was always dead weight, never the resolver that ran.
import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@chartwarden/auth";
import type { ConsentSessionContext, ConsentTypeKey } from "@chartwarden/consent";
import {
  type BereavementWindowPort,
  type CaseloadPort,
  type ConsentAccessDeps,
  type ConsentAccessSubject,
  type ConsentDisciplineScope,
  decideBereavementWindow,
  decideConsentReadScope,
  decideDisciplineScope,
  decideIsDrafter,
  decideOwnerOrCompliance,
  isComplianceOfficer,
  isComplianceOrPrivacyOfficer,
  isOrgAdminOrCompliance,
} from "./access-scope";
import { getConsentEvaluator } from "./seams";

/** The seven §4.8 predicates M39 registers → the consent type each evaluates against. */
const PREDICATE_CONSENT_TYPE: Record<string, ConsentTypeKey> = {
  sud_consent_present: "42_cfr_part_2_release",
  family_caregiver_access_active: "family_caregiver_access",
  portal_access_active: "portal_access",
  media_release_active: "media_release",
  research_participation_active: "research_participation",
  advance_directive_acknowledged: "advance_directive_acknowledgment",
  hipaa_release_active: "hipaa_release",
};

/** The seven predicate names M39 resolves (the §4.8 ownership set actually registered here). */
export const M39_ABAC_PREDICATES = Object.keys(PREDICATE_CONSENT_TYPE) as readonly string[];

/**
 * GAP-109 — the route-gating predicates M39 owns (§4.1 ABAC column). Namespaced `consent_*` where the
 * spec's bare name (`compliance_officer`, `privacy_officer`, `org_admin_or_compliance`,
 * `bereavement_window`) is generic or already owned by another module. The consent-keyed targets carry
 * facts the ROUTE resolved from the STORED consent row (`patientId`, `createdById`) — never a request claim.
 */
export const M39_ROUTE_ABAC_PREDICATES = [
  "consent_owner_or_compliance",
  "is_consent_drafter",
  "consent_compliance_officer",
  "consent_compliance_or_privacy_officer",
  "consent_org_admin_or_compliance",
  "consent_bereavement_window",
  "consent_read_scope",
  "consent_discipline_scope",
] as const;

const DISCIPLINE_SCOPES: readonly ConsentDisciplineScope[] = [
  "consent_management",
  "dpoa_clinical",
  "delegated_access",
  "post_mortem",
];
/** The surface a route names in its target; an unknown / missing one is `null` ⇒ deny. */
const scopeOf = (target: AbacTarget): ConsentDisciplineScope | null => {
  const value = target.disciplineScope;
  return DISCIPLINE_SCOPES.find((scope) => scope === value) ?? null;
};

const targetString = (target: AbacTarget, key: string): string => {
  const value = target[key];
  return typeof value === "string" ? value : "";
};

/** Project the request-derived ABAC context onto the pure decisions' subject. */
function subjectOf(context: AbacContext): ConsentAccessSubject {
  const pinned = context.attributes.sessionPatientId;
  return {
    organizationId: context.organizationId,
    userId: context.userId,
    roles: context.roles,
    sessionPatientId: typeof pinned === "string" && pinned.length > 0 ? pinned : null,
    membershipId:
      typeof context.attributes.membershipId === "string" ? context.attributes.membershipId : null,
  };
}

function registerConsentRoutePredicates(deps: ConsentAccessDeps): void {
  const caseload: CaseloadPort | undefined = deps.caseload;
  const bereavement: BereavementWindowPort | undefined = deps.bereavementWindow;
  registerPredicateIdempotent("consent_owner_or_compliance", (context, target) =>
    decideOwnerOrCompliance(subjectOf(context), targetString(target, "patientId"), caseload),
  );
  // §4.11 read chain: discipline scope, then caseload / owner-or-compliance OR the on-call window.
  registerPredicateIdempotent("consent_read_scope", (context, target) => {
    const scope = scopeOf(target);
    if (!scope) return false;
    return decideConsentReadScope(
      subjectOf(context),
      targetString(target, "patientId"),
      scope,
      deps,
    );
  });
  // Discipline scope alone (route 28 composes it ahead of its caseload / bereavement-window alternatives).
  registerPredicateIdempotent("consent_discipline_scope", (context, target) => {
    const scope = scopeOf(target);
    if (!scope) return false;
    const subject = subjectOf(context);
    const pinned = subject.sessionPatientId;
    if (pinned && pinned === targetString(target, "patientId")) return true;
    return decideDisciplineScope(subject.roles, scope);
  });
  registerPredicateIdempotent("is_consent_drafter", (context, target) =>
    decideIsDrafter(context, targetString(target, "createdById")),
  );
  registerPredicateIdempotent("consent_compliance_officer", (context) =>
    isComplianceOfficer(context.roles),
  );
  registerPredicateIdempotent("consent_compliance_or_privacy_officer", (context) =>
    isComplianceOrPrivacyOfficer(context.roles),
  );
  registerPredicateIdempotent("consent_org_admin_or_compliance", (context) =>
    isOrgAdminOrCompliance(context.roles),
  );
  registerPredicateIdempotent("consent_bereavement_window", (context, target) =>
    decideBereavementWindow(subjectOf(context), targetString(target, "patientId"), bereavement),
  );
}

/** Build the seam's session context from the ABAC request context (the originating membership). */
function sessionContextOf(context: AbacContext): ConsentSessionContext {
  const sessionClass =
    typeof context.attributes.sessionClass === "string" ? context.attributes.sessionClass : "staff";
  return { sessionClass, membershipId: context.userId };
}

/** The patient a consent predicate is about (route target carries `patientId` or `id`). */
function patientIdOf(target: AbacTarget): string | null {
  if (typeof target.patientId === "string") return target.patientId;
  if (typeof target.id === "string") return target.id;
  return null;
}

/**
 * Register M39's seven ABAC predicate resolvers into M3's registry (M39-T07; idempotent). Each
 * resolves through the `ConsentEvaluator` seam — so the predicate, the route gate, and the disclosure
 * path all share one decision (no drift). Call at boot after registerConsentSeams().
 */
export function registerConsentAbacPredicates(deps: ConsentAccessDeps = {}): void {
  registerConsentRoutePredicates(deps);
  for (const [name, consentType] of Object.entries(PREDICATE_CONSENT_TYPE)) {
    registerPredicateIdempotent(name, async (context: AbacContext, target: AbacTarget) => {
      const patientId = patientIdOf(target);
      if (!patientId || !context.organizationId) return false; // fail-closed
      const result = await getConsentEvaluator().evaluate({
        organizationId: context.organizationId,
        patientId,
        consentType,
        sessionContext: sessionContextOf(context),
        callerModule: "m3",
      });
      return result.allowed;
    });
  }
}
