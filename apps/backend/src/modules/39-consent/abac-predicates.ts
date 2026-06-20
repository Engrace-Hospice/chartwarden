// apps/backend/src/modules/39-consent/abac-predicates.ts — M39-T07 (spec §4.8).
//
// The ELEVEN named ABAC predicate resolvers M39 OWNS and registers into M3's named-predicate
// registry at boot. These gate OTHER modules' routes by name (M7/M8/M9/M11/M12/M13/M14/M15/M17/M18/
// M19/M22/M28/M30/M31/M33) — the consuming module writes `requireAbac('sud_disclosure_allowed', …)`
// and M3 resolves through the resolver registered here. Every resolver delegates to the published
// `ConsentEvaluator` seam (§4.3) so there is ONE decision engine; the predicate is a thin
// (patient, consentType) → allowed adapter. Registered once, idempotently (the registry is single-
// owner / no-clear, so re-boot in tests guards on `abacRegistry.has`).
import { type AbacContext, type AbacTarget, abacRegistry, registerPredicate } from "@wardenx/auth";
import { type ConsentSessionContext, type ConsentTypeKey } from "@wardenx/consent";
import { getConsentEvaluator } from "./seams";

/** The eleven §4.8 predicates → the consent type each evaluates against. */
const PREDICATE_CONSENT_TYPE: Record<string, ConsentTypeKey> = {
  sud_consent_present: "42_cfr_part_2_release",
  sud_disclosure_allowed: "42_cfr_part_2_release",
  dpoa_active: "dpoa_healthcare",
  family_caregiver_access_active: "family_caregiver_access",
  portal_access_active: "portal_access",
  telehealth_consent_active: "telehealth_consent",
  media_release_active: "media_release",
  research_participation_active: "research_participation",
  advance_directive_acknowledged: "advance_directive_acknowledgment",
  hipaa_release_active: "hipaa_release",
  // M15 registers this name; M39 owns the resolver (custom-type slot per D2 + M15 §4.5).
  family_violence_disclosure_allowed: "custom",
};

/** The eleven predicate names M39 resolves (the §4.8 ownership set). */
export const M39_ABAC_PREDICATES = Object.keys(PREDICATE_CONSENT_TYPE) as readonly string[];

/** Build the seam's session context from the ABAC request context (the originating membership). */
function sessionContextOf(context: AbacContext): ConsentSessionContext {
  const sessionClass = typeof context.attributes.sessionClass === "string" ? context.attributes.sessionClass : "staff";
  return { sessionClass, membershipId: context.userId };
}

/** The patient a consent predicate is about (route target carries `patientId` or `id`). */
function patientIdOf(target: AbacTarget): string | null {
  if (typeof target.patientId === "string") return target.patientId;
  if (typeof target.id === "string") return target.id;
  return null;
}

/**
 * Register M39's eleven ABAC predicate resolvers into M3's registry (M39-T07; idempotent). Each
 * resolves through the `ConsentEvaluator` seam — so the predicate, the route gate, and the disclosure
 * path all share one decision (no drift). Call at boot after registerConsentSeams().
 */
export function registerConsentAbacPredicates(): void {
  for (const [name, consentType] of Object.entries(PREDICATE_CONSENT_TYPE)) {
    if (abacRegistry.has(name)) continue; // single-owner registry; re-boot (tests) re-points safely
    registerPredicate(name, async (context: AbacContext, target: AbacTarget) => {
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
