// apps/backend/src/modules/15-discipline-care-plans/abac-predicates.ts — M15-T06 (§4.5 / D9).
//
// The FOUR named ABAC predicate resolvers M15 OWNS and registers into M3's named-predicate registry
// (M3 §3.4). Each is a typed `(context, target) => boolean` evaluated server-side AFTER RBAC passes; the
// subject facts are never read off the request body — they load through the injected
// {@link DisciplinePlanAbacResolver} (org-scoped, RLS-backstopped, fail-CLOSED when absent/cross-tenant).
//
//   aide_supervisor_eligible          — §4.5 / §8.6 (S): the caller IS the plan's named
//        `supervising_rn_membership_id`, OR a Clinical Supervisor whose session covers the plan's LOCATION
//        (the documented ≥40-char override reason is captured by the route/service, not relaxed here).
//   volunteer_compliance_active       — §4.5 / §7.4: the volunteer's 418.78 gates all clear right now, via
//        the SAME `effectiveStatusFor` derivation M17's pre-schedule gate reads through the LOCKED seam. An
//        unreadable gate store denies (§8.7 fail-CLOSED) — it never assumes compliance.
//   family_violence_disclosure_allowed — §4.5 / D9: family-violence psychosocial content is disclosable to
//        the MSW / RN Case Manager caseload default; every other principal (including a portal or external
//        collaborator session) is denied. M39 may narrow it further — never widen it — through the
//        `redactFamilyViolenceFields` verdict; an M39 outage REDACTS (deny), it never discloses.
//   volunteer_coordinator_role        — §4.5: the caller holds the Volunteer Coordinator role (the §4.1
//        routes 17–24 ∨-alternative, Compliance Officer, is composed at the route as a separate branch).
//
// The §4.1 inventory also names `caseload_or_scope` ∧ `discipline_scope` ∧ `sud_disclosure_allowed` ∧
// `dpoa_active` ∧ `signer_role_match` — all SHARED, registered by M5/M7 and keyed on M7's `planId` /
// `elementId` targets. M15's `:planId` is a DISCIPLINE plan id that M7's resolver cannot resolve, so
// binding them here by name would deny every M15 route permanently. M15 therefore enforces the equivalent
// gates in its own read/write services over the SAME upstream facts (the M5 `CaseloadProvider` +
// M39 `ConsentEvaluator` seams — see `routes/disclosure.ts`), which is the M9/M12/M13 posture.
//
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests) guards on
// `abacRegistry.has`.
import { type AbacContext, type AbacTarget, abacRegistry, registerPredicate } from "@wardenx/auth";
import type { IsoInstant, MembershipId } from "@wardenx/types";
import { type VolunteerGateFacts, effectiveStatusFor } from "./volunteer/index";

/** The §4.5 predicate names M15 owns (registered into M3). Single-owner across the platform registry. */
export const M15_ABAC_PREDICATES = [
  "aide_supervisor_eligible",
  "volunteer_compliance_active",
  "family_violence_disclosure_allowed",
  "volunteer_coordinator_role",
] as const;

export type M15RegisteredAbacPredicate = (typeof M15_ABAC_PREDICATES)[number];

/** The role key a Volunteer Coordinator holds (M3 role catalog / §6 permissions matrix). */
const VOLUNTEER_COORDINATOR_ROLE = "volunteer_coordinator";
/** Roles that may override the named supervising RN on an Aide POC supervisory attestation (§6). */
const SUPERVISORY_OVERRIDE_ROLES = ["clinical_supervisor", "director_of_nursing"] as const;
/** The caseload default §4.5 names for family-violence content: "MSW + RN Case Manager only". */
const FAMILY_VIOLENCE_DEFAULT_ROLES = [
  "msw",
  "rn_case_manager",
  "clinical_supervisor",
  "director_of_nursing",
] as const;
/** Session classes that never receive family-violence content, whatever their roles (§7.9). */
const NON_DISCLOSURE_SESSION_CLASSES = [
  "patient_portal",
  "caregiver_portal",
  "external_collaborator",
] as const;

/** The plan facts the supervisory predicate decides over (loaded org-scoped, never from the body). */
export interface DisciplinePlanScopeFacts {
  readonly organizationId: string;
  readonly patientId: string;
  readonly locationId: string;
  readonly supervisingRnMembershipId: MembershipId | null;
  readonly aideMembershipId: MembershipId | null;
}

/** The read surface M15's ABAC predicates resolve against (Drizzle in prod; in-memory in tests). */
export interface DisciplinePlanAbacResolver {
  /** Plan scope facts for a `discipline_care_plan` id, or null when absent / cross-tenant (fail-closed). */
  loadPlanScope(orgId: string, planId: string): Promise<DisciplinePlanScopeFacts | null>;
  /**
   * EVERY `volunteer_compliance_gate` row for a volunteer membership; `null` when the rows could not be
   * read, which §8.7 turns into a fail-CLOSED deny (never an assumed pass).
   */
  loadVolunteerGates(
    orgId: string,
    volunteerMembershipId: string,
  ): Promise<readonly VolunteerGateFacts[] | null>;
}

/** The M39 verdict the family-violence gate consults (structurally typed — no @wardenx/consent edge). */
export type FamilyViolenceRedactionProbe = (input: {
  readonly organizationId: string;
  readonly patientId: string;
}) => Promise<boolean>;

/** Deps for M15's §4.5 predicate resolvers. */
export interface DisciplinePlanAbacDeps {
  readonly resolver: DisciplinePlanAbacResolver;
  /** Injected clock — the gate derivation is time-dependent, so tests pin it. */
  readonly now?: () => IsoInstant;
  /**
   * Whether M39 says family-violence content must be REDACTED for this patient. Defaults to "not
   * redacted" only when M39 is bound; the default probe below fails CLOSED (redact) on any error.
   */
  readonly familyViolenceRedacted?: FamilyViolenceRedactionProbe;
}

/** A resolver that denies everything — the shape a boot-without-DB path binds (fail-closed, never open). */
export const denyStubDisciplinePlanAbacResolver: DisciplinePlanAbacResolver = {
  async loadPlanScope() {
    return null;
  },
  async loadVolunteerGates() {
    return null; // §8.7 — unreadable gate store denies
  },
};

const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

const hasRole = (context: AbacContext, role: string): boolean => context.roles.includes(role);

/** The actor's ACTIVE membership id (M2 assembles it onto `attributes`); null when absent (fail-closed). */
const membershipIdOf = (context: AbacContext): string | null => {
  const value = context.attributes.membershipId;
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** The session class M2 stamped on the request (`staff` when unstated). */
const sessionClassOf = (context: AbacContext): string => {
  const value = context.attributes.sessionClass;
  return typeof value === "string" && value.length > 0 ? value : "staff";
};

/**
 * Build M15's four §4.5 predicate resolvers over injected deps (pure factory — unit-tested against a fresh
 * registry; the boot path registers them via {@link registerDisciplinePlanAbacPredicates}). Targets:
 * `planId` for the supervisory gate, `volunteerMembershipId` for the compliance gate, `planId` (or a direct
 * `patientId`) for the family-violence gate; the coordinator-role gate needs no target.
 */
export function buildDisciplinePlanAbacPredicates(
  deps: DisciplinePlanAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  const now = deps.now ?? (() => new Date().toISOString() as IsoInstant);
  // Fail-CLOSED default: with no probe bound the family-violence gate falls back to the §4.5 role default
  // ALONE (no M39 widening) — `false` here means "M39 does not additionally redact", never "M39 allows".
  const familyViolenceRedacted = deps.familyViolenceRedacted ?? (async () => false);

  return {
    aide_supervisor_eligible: async (context, target) => {
      const planId = targetStr(target, "planId") ?? targetStr(target, "id");
      if (!planId) return false; // no plan named → deny (fail-closed)
      const facts = await resolver.loadPlanScope(context.organizationId, planId);
      if (!facts) return false; // absent / cross-tenant
      if (facts.organizationId !== context.organizationId) return false; // defense in depth
      const membershipId = membershipIdOf(context);
      if (membershipId !== null && facts.supervisingRnMembershipId === membershipId) return true;
      // §6 — the Clinical Supervisor / DON override, still narrowed to the plan's own location.
      if (!SUPERVISORY_OVERRIDE_ROLES.some((r) => hasRole(context, r))) return false;
      return context.locationIds.includes(facts.locationId);
    },

    volunteer_compliance_active: async (context, target) => {
      const volunteerId =
        targetStr(target, "volunteerMembershipId") ?? targetStr(target, "membershipId");
      if (!volunteerId) return false; // no volunteer named → deny (fail-closed)
      const gates = await resolver.loadVolunteerGates(context.organizationId, volunteerId);
      // `gates === null` (unreadable store) flows into effectiveStatusFor, which denies per §8.7.
      return effectiveStatusFor(volunteerId as MembershipId, gates, now()).isActive;
    },

    family_violence_disclosure_allowed: async (context, target) => {
      if (NON_DISCLOSURE_SESSION_CLASSES.includes(sessionClassOf(context) as never)) return false;
      if (!FAMILY_VIOLENCE_DEFAULT_ROLES.some((r) => hasRole(context, r))) return false;
      // Resolve the patient: either named directly, or through the plan the route addresses.
      let patientId = targetStr(target, "patientId");
      if (patientId === null) {
        const planId = targetStr(target, "planId") ?? targetStr(target, "id");
        if (!planId) return false;
        const facts = await resolver.loadPlanScope(context.organizationId, planId);
        if (!facts) return false;
        patientId = facts.patientId;
      }
      try {
        const redacted = await familyViolenceRedacted({
          organizationId: context.organizationId,
          patientId,
        });
        return !redacted;
      } catch {
        return false; // §8.7 — an M39 outage REDACTS; it never discloses
      }
    },

    volunteer_coordinator_role: async (context) => hasRole(context, VOLUNTEER_COORDINATOR_ROLE),
  };
}

/**
 * Register M15's four §4.5 ABAC predicate resolvers into M3's shared registry (M15-T06; idempotent). Call
 * at boot after the M15 route services are constructed (the resolver reads the same tables). Re-boot
 * (tests) skips already-registered names (single-owner / no-clear).
 */
export function registerDisciplinePlanAbacPredicates(deps: DisciplinePlanAbacDeps): void {
  const predicates = buildDisciplinePlanAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    if (abacRegistry.has(name)) continue;
    registerPredicate(name, predicate);
  }
}
