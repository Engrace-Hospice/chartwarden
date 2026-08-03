// apps/backend/src/modules/16-bereavement/abac-predicates.ts — M16-T06 (§4.8).
//
// The FOUR named ABAC predicate resolvers M16 registers into M3's named-predicate registry (M3 §3.4). Each
// is a typed `(context, target) => boolean` evaluated server-side AFTER RBAC passes; the subject facts are
// never read off the request body — they load through the injected {@link BereavementAbacResolver}
// (org-scoped, RLS-backstopped, fail-CLOSED when absent / cross-tenant).
//
//   bereavement_window                 — §4.8: the target's plan is `active` or `paused` AND the caller is
//        the plan's assigned counselor, its assigned volunteer, or holds org-scoped bereavement oversight.
//        The `∨ org_scope_bereavement_oversight` alternative every §4.1 read row names is a DISJUNCT INSIDE
//        this predicate (a `requireAbac` binds exactly one name and preHandlers compose by AND, so an OR
//        expressed as two guards would be an AND — the strictly wrong gate).
//   discipline_can_provide_bereavement — §4.8 / D5: the subject's discipline ∈ {bereavement_counselor,
//        medical_social_worker, chaplain, bereavement_volunteer}; for the volunteer discipline the 418.78
//        gates must ALSO be satisfied, resolved through M15's published `VolunteerComplianceProvider` seam
//        so there is ONE gate implementation rather than an M16 copy. The subject is the ACTOR by default
//        and the ASSIGNEE when the target names `counselorUserId` / `volunteerUserId` (§4.1 routes 3 / 4).
//   org_scope_bereavement_oversight    — §4.8 names this "reused / M3 §4.2 family", but NO module on the
//        platform registers it. An unregistered predicate denies exactly like a typo does, so M16 registers
//        it: the caller holds one of the organization-scoped bereavement-oversight roles.
//   portal_self_service                — §4.8 "reused" for the same reason: the caller is the bereaved
//        contact themselves, on an M31 portal session whose `portalAccountId` matches the target contact's.
//        A STAFF session never satisfies it, whatever its roles, and a portal session that names no account
//        is denied rather than treated as "the contact".
//
// `volunteer_gates_satisfied` (§4.8's fifth row, "reused (M2)") is deliberately NOT registered here: §4.8
// itself only ever consumes it FROM `discipline_can_provide_bereavement`, and M15 already owns the 418.78
// derivation behind `VolunteerComplianceProvider`. Registering a second name for the same fact would let a
// future route bind the one that happens to be stale.
//
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests) guards on
// `abacRegistry.has`.
import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@wardenx/auth";
import { isClosedPlanStatus } from "@wardenx/bereavement";
import type { BereavementPlanStatus, MembershipId } from "@wardenx/types";

/** The §4.8 predicate names M16 owns (registered into M3). Single-owner across the platform registry. */
export const M16_ABAC_PREDICATES = [
  "bereavement_window",
  "discipline_can_provide_bereavement",
  "org_scope_bereavement_oversight",
  "portal_self_service",
] as const;

export type M16RegisteredAbacPredicate = (typeof M16_ABAC_PREDICATES)[number];

/**
 * §4.8 — the roles that carry organization-scoped bereavement oversight ("typically Clinical Supervisor,
 * DON, Bereavement Program Coordinator, Compliance Officer").
 */
export const BEREAVEMENT_OVERSIGHT_ROLES = [
  "clinical_supervisor",
  "director_of_nursing",
  "bereavement_program_coordinator",
  "compliance_officer",
] as const;

/** §4.8 / D5 — the M40 disciplines that may provide bereavement services. */
export const BEREAVEMENT_CAPABLE_DISCIPLINES = [
  "bereavement_counselor",
  "medical_social_worker",
  "chaplain",
  "bereavement_volunteer",
] as const;

/** The one discipline in the set whose eligibility ALSO depends on the 418.78 compliance gates. */
export const BEREAVEMENT_VOLUNTEER_DISCIPLINE = "bereavement_volunteer";

/**
 * §4.8 / D5 — M3 role key → the M40 discipline it evidences.
 *
 * WHY A ROLE MAP AND NOT AN M40 READ: §4.8 phrases the rule as "the actor's M40 discipline", but no bound
 * seam exposes a WORKFORCE discipline — `MdmEntityProvider` is master data about physicians / facilities /
 * payers, not about staff, and the `membership` row carries no discipline column. The one place the
 * platform already derives a discipline is M3's `RoleGrant.roleKey` (its own doc-comment says
 * "for diagnostics / discipline derivation"), so that is what M16 reads, through the M3-owned
 * `EffectivePermissionStore` port rather than by importing M3's `role` / `membership_role` schema.
 * A role key nobody granted resolves to `null`, which denies.
 */
export const DISCIPLINE_FOR_ROLE_KEY: Readonly<Record<string, string>> = {
  bereavement_counselor: "bereavement_counselor",
  bereavement_coordinator: "bereavement_counselor",
  msw: "medical_social_worker",
  medical_social_worker: "medical_social_worker",
  social_worker: "medical_social_worker",
  chaplain: "chaplain",
  spiritual_care_counselor: "chaplain",
  bereavement_volunteer: BEREAVEMENT_VOLUNTEER_DISCIPLINE,
  volunteer: BEREAVEMENT_VOLUNTEER_DISCIPLINE,
};

/**
 * The bereavement-capable discipline a role-key set evidences, or null. When a membership holds several
 * (an MSW who also volunteers), the STRONGEST is returned — a paid clinician's eligibility must not be
 * downgraded to the volunteer path and then denied for want of a 418.78 TB screening.
 */
export function disciplineForRoleKeys(roleKeys: readonly string[]): string | null {
  let volunteer: string | null = null;
  for (const key of roleKeys) {
    const discipline = DISCIPLINE_FOR_ROLE_KEY[key];
    if (discipline === undefined) continue;
    if (discipline !== BEREAVEMENT_VOLUNTEER_DISCIPLINE) return discipline;
    volunteer = discipline;
  }
  return volunteer;
}

/** M2 session classes that are a bereaved family member's own portal session (§4.8 `portal_self_service`). */
const PORTAL_SESSION_CLASSES = ["caregiver_portal", "patient_portal", "bereaved_portal"] as const;

/** The plan facts `bereavement_window` decides over (loaded org-scoped, never read off the request). */
export interface BereavementPlanAbacFacts {
  readonly organizationId: string;
  readonly planId: string;
  readonly status: BereavementPlanStatus;
  readonly assignedCounselorUserId: MembershipId | null;
  readonly assignedVolunteerUserId: MembershipId | null;
}

/** The contact facts `portal_self_service` decides over. */
export interface BereavedContactAbacFacts {
  readonly organizationId: string;
  readonly contactId: string;
  readonly planId: string;
  readonly portalAccountId: string | null;
}

/** The read surface M16's ABAC predicates resolve against (Drizzle in prod; in-memory in tests). */
export interface BereavementAbacResolver {
  /** Plan facts for a `bereavement_plan` id, or null when absent / cross-tenant (fail-closed). */
  loadPlan(orgId: string, planId: string): Promise<BereavementPlanAbacFacts | null>;
  /** Resolve the plan a `bereaved_contact` hangs off (routes 12–18 address the contact, not the plan). */
  loadPlanForContact(orgId: string, contactId: string): Promise<BereavementPlanAbacFacts | null>;
  /** Resolve the plan a `bereavement_outreach` row hangs off (routes 20–25 address the touchpoint). */
  loadPlanForOutreach(orgId: string, outreachId: string): Promise<BereavementPlanAbacFacts | null>;
  /** Contact facts for the portal-self gate, or null when absent / cross-tenant (fail-closed). */
  loadContact(orgId: string, contactId: string): Promise<BereavedContactAbacFacts | null>;
  /**
   * The bereavement-capable discipline a workforce subject evidences, or null when it cannot be resolved.
   * `null` DENIES — an unreadable discipline is never an eligible one (§8.7). See
   * {@link DISCIPLINE_FOR_ROLE_KEY} for why this is derived from M3 role grants.
   */
  disciplineOf(orgId: string, subjectId: string): Promise<string | null>;
}

/**
 * The M15 418.78 verdict `discipline_can_provide_bereavement` consults for the volunteer discipline.
 * Structurally typed so M16 takes no `@wardenx/discipline-plans` import edge — the production probe resolves
 * `VolunteerComplianceProvider` through the M1 seam registry.
 */
export type VolunteerGatesProbe = (input: {
  readonly organizationId: string;
  readonly volunteerMembershipId: string;
}) => Promise<boolean>;

/** Deps for M16's §4.8 predicate resolvers. */
export interface BereavementAbacDeps {
  readonly resolver: BereavementAbacResolver;
  /**
   * Whether the volunteer's 418.78 gates are all satisfied right now. Defaults to a probe that DENIES: an
   * unbound M15 seam must not be read as "the gates are clear" (§8.7 fail-CLOSED, and the same posture M15's
   * own `volunteer_compliance_active` takes on an unreadable gate store).
   */
  readonly volunteerGatesSatisfied?: VolunteerGatesProbe;
}

/** A resolver that denies everything — the shape a boot-without-DB path binds (fail-closed, never open). */
export const denyStubBereavementAbacResolver: BereavementAbacResolver = {
  async loadPlan() {
    return null;
  },
  async loadPlanForContact() {
    return null;
  },
  async loadPlanForOutreach() {
    return null;
  },
  async loadContact() {
    return null;
  },
  async disciplineOf() {
    return null;
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

/** The M31 portal account the session belongs to; null on a staff session. */
const portalAccountIdOf = (context: AbacContext): string | null => {
  const value = context.attributes.portalAccountId;
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** §4.8 — does the caller hold organization-scoped bereavement oversight? (Also a disjunct of the window.) */
export function hasBereavementOversight(context: AbacContext): boolean {
  return BEREAVEMENT_OVERSIGHT_ROLES.some((role) => hasRole(context, role));
}

/**
 * Resolve the plan a target names, whichever id shape the route carries. Order matters: an explicit
 * `planId` wins, then the contact, then the touchpoint. A target that names NOTHING resolves to null, which
 * denies — a route that forgot its `getTarget` fails closed rather than being evaluated against no subject.
 */
async function resolveTargetPlan(
  resolver: BereavementAbacResolver,
  orgId: string,
  target: AbacTarget,
): Promise<BereavementPlanAbacFacts | null> {
  const planId = targetStr(target, "planId") ?? targetStr(target, "id");
  if (planId !== null) return resolver.loadPlan(orgId, planId);
  const contactId = targetStr(target, "contactId");
  if (contactId !== null) return resolver.loadPlanForContact(orgId, contactId);
  const outreachId = targetStr(target, "outreachId");
  if (outreachId !== null) return resolver.loadPlanForOutreach(orgId, outreachId);
  return null;
}

/**
 * §4.8 `bereavement_window` over already-resolved plan facts. Split out from the registry closure so the
 * §9.1 unit tests exercise the RULE without a resolver, and so the route services can ask the same question
 * on a row they already hold instead of re-reading it.
 *
 * A CLOSED plan is outside the window even mid-13-months (the same rule
 * `BereavementPlanProvider.isInBereavementWindow` applies), and `eligible` / `initiating` are outside it
 * too — §4.8 pins the predicate to `{active, paused}`. That is why the §4.1 pre-active routes (3 assign
 * counselor, 4 assign volunteer, 5 seed roster) bind `org_scope_bereavement_oversight` instead: binding the
 * window predicate there would deny FOREVER, since a plan is `initiating` at exactly the moment it is
 * being activated.
 */
export function decideBereavementWindow(
  facts: BereavementPlanAbacFacts,
  actor: {
    readonly organizationId: string;
    readonly membershipId: string | null;
    readonly hasOversight: boolean;
  },
): boolean {
  if (facts.organizationId !== actor.organizationId) return false; // defense in depth behind RLS
  if (isClosedPlanStatus(facts.status)) return false;
  if (facts.status !== "active" && facts.status !== "paused") return false;
  if (actor.hasOversight) return true;
  if (actor.membershipId === null) return false;
  return (
    facts.assignedCounselorUserId === actor.membershipId ||
    facts.assignedVolunteerUserId === actor.membershipId
  );
}

/**
 * Build M16's four §4.8 predicate resolvers over injected deps (pure factory — unit-tested against a fresh
 * registry; the boot path registers them via {@link registerBereavementAbacPredicates}).
 */
export function buildBereavementAbacPredicates(
  deps: BereavementAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  // Fail-CLOSED default: with no probe bound, a bereavement VOLUNTEER is refused. The other three
  // disciplines are unaffected — an M15 outage must not ground the counselors too.
  const volunteerGatesSatisfied = deps.volunteerGatesSatisfied ?? (async () => false);

  return {
    bereavement_window: async (context, target) => {
      const facts = await resolveTargetPlan(resolver, context.organizationId, target);
      if (facts === null) return false; // absent / cross-tenant / no subject named
      return decideBereavementWindow(facts, {
        organizationId: context.organizationId,
        membershipId: membershipIdOf(context),
        hasOversight: hasBereavementOversight(context),
      });
    },

    discipline_can_provide_bereavement: async (context, target) => {
      // Routes 3 / 4 ask about the ASSIGNEE; every other binding asks about the caller (route 18's
      // `flag_complicated_grief` and route 30's counselor dashboard are `(self)` in §4.1).
      const named =
        targetStr(target, "counselorUserId") ??
        targetStr(target, "volunteerUserId") ??
        targetStr(target, "subjectMembershipId");
      const subject = named ?? membershipIdOf(context);
      if (subject === null) return false;
      // SELF fast path: the acting session's role keys are already server-assembled by M2, so asking the
      // resolver to re-read what the request context holds would add a DB round-trip per guarded route —
      // and would deny on a boot-without-DB path where the session itself is perfectly well known.
      const discipline =
        named === null
          ? (disciplineForRoleKeys(context.roles) ??
            (await resolver.disciplineOf(context.organizationId, subject)))
          : await resolver.disciplineOf(context.organizationId, subject);
      // `null` is "we could not find out", which denies. It is NOT "no discipline on file means anyone".
      if (discipline === null) return false;
      if (!BEREAVEMENT_CAPABLE_DISCIPLINES.includes(discipline as never)) return false;
      if (discipline !== BEREAVEMENT_VOLUNTEER_DISCIPLINE) return true;
      try {
        return await volunteerGatesSatisfied({
          organizationId: context.organizationId,
          volunteerMembershipId: subject,
        });
      } catch {
        return false; // §8.7 — an M15 outage denies the volunteer; it never assumes compliance
      }
    },

    org_scope_bereavement_oversight: async (context) => hasBereavementOversight(context),

    portal_self_service: async (context, target) => {
      if (!PORTAL_SESSION_CLASSES.includes(sessionClassOf(context) as never)) return false;
      const portalAccountId = portalAccountIdOf(context);
      if (portalAccountId === null) return false;
      const contactId = targetStr(target, "contactId") ?? targetStr(target, "id");
      if (contactId === null) return false;
      const contact = await resolver.loadContact(context.organizationId, contactId);
      if (contact === null) return false;
      if (contact.organizationId !== context.organizationId) return false;
      return contact.portalAccountId === portalAccountId;
    },
  };
}

/**
 * Register M16's four §4.8 ABAC predicate resolvers into M3's shared registry (M16-T06; idempotent). Call at
 * boot after the M16 route services are constructed (the resolver reads the same tables). Re-boot (tests)
 * skips already-registered names (single-owner / no-clear).
 */
export function registerBereavementAbacPredicates(deps: BereavementAbacDeps): void {
  const predicates = buildBereavementAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
