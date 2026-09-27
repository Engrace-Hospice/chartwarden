// apps/backend/src/modules/06-admission/abac-predicates.ts — M6-T06 (spec §4.6).
//
// The TEN named ABAC predicate resolvers M6 OWNS and registers into M3's named-predicate registry
// (M3 §3.4). Each is a typed `(context, target) => boolean` evaluated server-side AFTER RBAC passes;
// M6 never authorizes by reading the request body — the resource's owner facts are loaded through the
// injected `AdmissionAbacResolver` (org-scoped, RLS-backstopped). `patient.scope` (route 8) is M5's
// re-used predicate — M6 does not own or register it.
//
// FOUR of the ten are pure over `context.roles` (no resolver, no closure) — `f2f.is_hospice_md_or_np`,
// `f2f.window_override`, `discharge.is_medical_director`, `compliance.window_override`. The routes
// wire `requireAbac` on those four (the spec's role-gated signer/override predicates). The remaining
// six are resource-bound (scope + signer-identity); they are registered for the §4.6 handshake and
// resolve a resource's owner facts, with full route-level `requireAbac` wiring landing alongside the
// Drizzle resolver in the M6 workflow tasks.
//
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests)
// is idempotent via registerPredicateIdempotent.
import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@wardenx/auth";
import { getSeam } from "../../bootstrap/index";
import type { AdmissionAbacResolver } from "./routes/service";

/** The §4.6 predicate names M6 owns (registered into M3). `patient.scope` is excluded — it is M5's. */
export const M6_ABAC_PREDICATES = [
  "referral.scope",
  "admission.scope",
  "cti.is_hospice_md",
  "cti.is_attending",
  "f2f.is_hospice_clinician",
  "f2f.is_hospice_md_or_np",
  "f2f.window_override",
  "discharge.is_medical_director",
  "compliance.scope",
  "compliance.window_override",
] as const;

/** The four §4.6 predicates the routes wire via `requireAbac` (pure over `context.roles`). */
export const M6_ROLE_PREDICATE_NAMES = {
  f2fAttest: "f2f.is_hospice_md_or_np",
  f2fWindowOverride: "f2f.window_override",
  dischargeMedicalDirector: "discharge.is_medical_director",
  complianceWindowOverride: "compliance.window_override",
} as const;

const MD_OR_NP = ["medical_director", "hospice_physician", "np","rn_case_manager",
  "rn",] as const;
  
const UNSITED_ADMISSION_ROLES = [
  "intake_coordinator",
  "intake_supervisor",
  "admissions_team",
  "org_admin",
  "tenant_admin",
] as const;

/** Deps for M6's ABAC predicate resolvers (the slice injects an in-memory resolver + caseload stub). */
export interface AdmissionAbacDeps {
  /** Loads a resource's org-scoped owner facts (in-memory in the slice; Drizzle in prod). */
  readonly resolver: AdmissionAbacResolver;
  /** Caseload membership check (defaults to the boot-registered M5 `CaseloadProvider` seam). */
  readonly isInCaseload?: (q: {
    organizationId: string;
    userId: string;
    patientId: string;
  }) => Promise<boolean>;
}

const hasRole = (context: AbacContext, role: string): boolean => context.roles.includes(role);
const targetId = (target: AbacTarget): string | null =>
  typeof target.id === "string" && target.id.length > 0 ? target.id : null;

/**
 * GAP-011 — the resource kinds `admission.scope`'s target `:id` may name. A route whose path param is
 * literally an admission id (the majority) omits `resourceKind` (defaults to `"admission"`); a route
 * keyed by a CHILD resource (election period/statement, CTI, F2F, LOC period, compliance window) sets
 * it explicitly via `requireAbac`'s `getTarget` (admission-routes.ts) so the predicate resolves scope
 * through the resource's OWNING admission rather than treating the child id as an admission id.
 */
export type AdmissionScopeResourceKind =
  | "admission"
  | "electionPeriod"
  | "electionStatement"
  | "cti"
  | "f2f"
  | "loc"
  | "complianceWindow";

function resourceKindOf(target: AbacTarget): AdmissionScopeResourceKind {
  const kind = target.resourceKind;
  return kind === "electionPeriod" ||
    kind === "electionStatement" ||
    kind === "cti" ||
    kind === "f2f" ||
    kind === "loc" ||
    kind === "complianceWindow"
    ? kind
    : "admission";
}

/**
 * Build M6's ten §4.6 predicate resolvers over injected deps (pure factory — unit-tested with a fresh
 * registry; the boot path registers these into the shared registry via {@link registerAdmissionAbacPredicates}).
 */
export function buildAdmissionAbacPredicates(
  deps: AdmissionAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  const isInCaseload = deps.isInCaseload ?? ((q) => getSeam("CaseloadProvider").isInCaseload(q));

  /** Caseload-or-scope over an admission's patient (medical_director = org-wide). §4.6 admission.scope. */
  const admissionScopeFor = async (
    context: AbacContext,
    facts: { patientId: string; providerEntityId: string | null },
  ): Promise<boolean> => {
    if (hasRole(context, "medical_director")) return true; // org-wide
    if (
      facts.providerEntityId === null &&
      UNSITED_ADMISSION_ROLES.some((role) => hasRole(context, role))
    )
      return true;
    if (facts.providerEntityId && context.providerEntityIds.includes(facts.providerEntityId))
      return true;
    if (!context.userId) return false;
    return isInCaseload({
      organizationId: context.organizationId,
      userId: context.userId,
      patientId: facts.patientId,
    });
  };

  return {
    "referral.scope": async (context, target) => {
      const id = targetId(target);
      if (!id) return false;
      const facts = await resolver.loadReferral(context.organizationId, id);
      if (!facts) return false; // fail-closed (absent / cross-tenant)
      const orgWide = context.locationIds.length === 0; // no location restriction = org-wide
      if (orgWide) return true;
      // A null location is a referral's DOCUMENTED steady state ("org-level until an admission
      // activates them" — referrals.ts header): no write path assigns location_id at intake, so an
      // org-level referral is visible to every org member, location-scoped or not. Denying null here
      // 404'd every referral for every location-scoped user (2026-08-14 review). The location test
      // only bites once a location IS assigned.
      return facts.locationId === null || context.locationIds.includes(facts.locationId);
    },
    "admission.scope": async (context, target) => {
      const id = targetId(target);
      if (!id) return false;
      const facts = await (async () => {
        switch (resourceKindOf(target)) {
          case "admission":
            return resolver.loadAdmission(context.organizationId, id);
          case "electionPeriod":
            return resolver.loadElectionPeriodScope(context.organizationId, id);
          case "electionStatement":
            return resolver.loadElectionStatementScope(context.organizationId, id);
          case "cti":
            return resolver.loadCtiScope(context.organizationId, id);
          case "f2f":
            return resolver.loadF2fScope(context.organizationId, id);
          case "loc":
            return resolver.loadLocScope(context.organizationId, id);
          case "complianceWindow":
            return resolver.loadComplianceWindow(context.organizationId, id);
        }
      })();
      if (!facts) return false; // fail-closed (absent / cross-tenant)
      return admissionScopeFor(context, facts);
    },
    // The identity halves of the two CTI sign gates compare `context.userId` (a Better Auth user
    // id) against the CTI's `hospice_md_id`/`attending_md_id` — M40 physician-DIRECTORY uuids with
    // no FK (or join anywhere in the schema) to `users`. Until a user↔M40-physician link exists
    // that comparison can never be true in production, so the ROLE escape is the live path and must
    // name role keys that actually exist. The previous escapes (`acting_medical_director`,
    // `attending_physician_collaborator`) existed in no template, seed, or tenant — no CTI could be
    // signed, so no admission could be certified, in any org (2026-08-14 review). The keys below
    // follow the repo-wide clinical role-key convention (seed-staff-personas.ts, MD_OR_NP above).
    "cti.is_hospice_md": async (context, target) => {
      const id = targetId(target);
      if (!id) return false;
      const facts = await resolver.loadCti(context.organizationId, id);
      if (!facts) return false;
      // §418.22(c): the hospice side is certified by the medical director or the physician
      // designee (hospice physician) — NPs may never certify terminal illness.
      return (
        context.userId === facts.hospiceMedicalDirectorId ||
        hasRole(context, "medical_director") ||
        hasRole(context, "hospice_physician")
      );
    },
    "cti.is_attending": async (context, target) => {
      const id = targetId(target);
      if (!id) return false;
      const facts = await resolver.loadCti(context.organizationId, id);
      if (!facts) return false;
      // The attending signature is also a physician certification (§418.22(c)); when the patient's
      // chosen attending is the hospice's own physician, that user holds `hospice_physician`.
      return (
        (facts.attendingPhysicianId !== null && context.userId === facts.attendingPhysicianId) ||
        hasRole(context, "md") ||
        hasRole(context, "hospice_physician")
      );
    },
    "f2f.is_hospice_clinician": async (context, target) => {
      const id = targetId(target);
      if (!id) return false;
      const facts = await resolver.loadF2f(context.organizationId, id);
      if (!facts) return false;
      return context.userId === facts.scheduledClinicianId || hasRole(context, "medical_director");
    },
    "f2f.is_hospice_md_or_np": async (context) => MD_OR_NP.some((r) => hasRole(context, r)),
    "f2f.window_override": async (context) => hasRole(context, "compliance_officer"),
    "discharge.is_medical_director": async (context) => hasRole(context, "medical_director"),
    "compliance.scope": async (context, target) => {
      if (hasRole(context, "compliance_officer")) return true; // org-wide
      const id = targetId(target);
      if (!id) return false;
      const facts = await resolver.loadComplianceWindow(context.organizationId, id);
      if (!facts) return false;
      return admissionScopeFor(context, {
        patientId: facts.patientId,
        providerEntityId: facts.providerEntityId,
      });
    },
    "compliance.window_override": async (context) => hasRole(context, "compliance_officer"),
  };
}

/**
 * Register M6's ten §4.6 ABAC predicate resolvers into M3's shared registry (M6-T06; idempotent).
 * Call at boot after the M5 `CaseloadProvider` seam is registered (admission/compliance scope resolve
 * caseload through it). Re-boot (tests) skips already-registered names (single-owner / no-clear).
 */
export function registerAdmissionAbacPredicates(deps: AdmissionAbacDeps): void {
  const predicates = buildAdmissionAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
