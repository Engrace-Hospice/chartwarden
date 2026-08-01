// apps/backend/src/modules/19-oncall/abac-predicates.ts — M19-T07 (§4.7 / §8.2).
//
// The SIX named ABAC predicate resolvers M19 registers into M3's named-predicate registry. Each is a typed
// `(context, target) => boolean` evaluated server-side AFTER RBAC passes; every subject fact is loaded
// through the injected {@link OncallAbacResolver} (org-scoped, RLS-backstopped) or a cross-module seam —
// never read off the request body.
//
//   oncall_eligible                — §4.7's three paths: (a) an ACTIVE `on_call_shift` covering now for the
//        membership, (b) a supervisor / org-admin / medical-director role, (c) a match in M17's
//        `tonightsOnCallRoster` (the Direct-model fallback for the window between a roster change and the
//        next shift-sync tick).
//   triage_call_owner_or_supervisor— §4.7: the actor is in the CALL'S PATIENT's caseload, or is
//        `oncall_eligible` for the call's ProviderEntity. The per-call routes (#3-#15) bind it.
//   external_triage_actor          — §4.7 / §7.5: a Hybrid/Centralized VENDOR session, scoped to calls
//        opened under its own vendor identity (`on_call_shift.external_actor_id`).
//   escalation_recipient_scope     — §4.7: the escalation INBOX (#16). True when the actor's role
//        intersects any escalation tier; the row filter narrows what they actually see.
//   escalation_recipient           — §4.7: acknowledge / resolve (#17, #18) — the escalated-to membership,
//        or a role inside the tier.
//   portal_session_consent_active  — §4.7: the M31 portal route (#36), validating M39's
//        `family_caregiver_access` consent for the SPECIFIC patient.
//
// TWO DESIGN DECISIONS THAT ARE EASY TO GET EXACTLY BACKWARDS.
//
//   1. `triage_call_owner_or_supervisor` AND `external_triage_actor` ARE ALTERNATIVES, NOT A CONJUNCTION,
//      and §4.1's per-call rows spell the cell "(same)" for both audiences. Two `requireAbac` preHandlers
//      would AND (the M16-T06 finding), and ANDing them denies every caller: a staff clinician holds no
//      vendor identity and a vendor operator holds no caseload. So the ROUTE picks the predicate NAME by
//      the SERVER-assembled session class (`routes/guards.ts` `ABAC_CALL_ACTOR`) — one preHandler, one
//      name, both predicates live and independently testable. Folding the vendor arm INTO the owner
//      predicate was the alternative and is worse: it would let any staff session that happened to carry
//      an `externalActorId` attribute reach a vendor-scoped call.
//   2. THE FAIL DIRECTION IS UNIFORM HERE: unreadable resolver, unknown target, absent row, cross-tenant
//      id and thrown error all DENY. Unlike M15/M16, where the posture split per seam, every one of these
//      six is an AUTHORIZATION read — there is no M19 fact whose unavailability should be read as
//      permission to open, read or disposition a call. §2.4's "a coverage gap must ALERT rather than
//      block" is about the WATCHDOG and about boot; it is not a licence to let an unknown actor answer
//      the after-hours line.
//
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests) guards on
// `abacRegistry.has`.
import { type AbacContext, type AbacTarget, abacRegistry, registerPredicate } from "@wardenx/auth";
import type { MembershipId, OncallShiftDiscipline, TriageEscalationTier } from "@wardenx/types";
import { getSeam } from "../../bootstrap/index";
import type { TriageActorDiscipline } from "./lifecycle/protocol";

/** The §4.7 predicate names M19 OWNS (registered into M3). Single-owner across the platform registry. */
export const M19_ABAC_PREDICATES = [
  "oncall_eligible",
  "triage_call_owner_or_supervisor",
  "external_triage_actor",
  "escalation_recipient_scope",
  "escalation_recipient",
  "portal_session_consent_active",
] as const;

export type M19RegisteredAbacPredicate = (typeof M19_ABAC_PREDICATES)[number];

/**
 * §4.7(b) — the role keys that carry on-call authority BY OFFICE, without a shift row. §4.7's own list is
 * `clinical_supervisor`, `org_admin`, `medical_director`; `director_of_nursing` and `administrator` are the
 * M3 role-template spellings of the same two offices (`templates.ts` has no `org_admin` key — the
 * administrator template is what an org admin holds), and omitting them would make the §6 "Clin Supv / DON"
 * column unreachable for the very roles §6 grants the widest triage access.
 */
export const ONCALL_OVERSIGHT_ROLES = [
  "clinical_supervisor",
  "clinical_manager",
  "director_of_nursing",
  "administrator",
  "org_admin",
  "medical_director",
] as const;

/**
 * §4.7 `escalation_recipient_scope` — the roles that sit on SOME rung of the §3.2 tier ladder. Verbatim
 * from §4.7's list plus the two M3-template spellings above, for the same reason.
 *
 * `compliance_officer` is on the list because tier 4 IS the compliance officer; a surveyor is NOT, because
 * §6 grants Surveyor a READ of the inbox through the engagement-scope path, not membership of a tier.
 */
export const ESCALATION_TIER_ROLES = [
  "clinical_supervisor",
  "clinical_manager",
  "director_of_nursing",
  "administrator",
  "org_admin",
  "medical_director",
  "compliance_officer",
] as const;

/** §4.7 `escalation_recipient` — which role keys stand in for each tier when no membership is named. */
export const ROLES_BY_ESCALATION_TIER: {
  readonly [K in TriageEscalationTier]: readonly string[];
} = {
  tier_1_rn_supervisor: ["clinical_supervisor", "director_of_nursing", "administrator", "org_admin"],
  tier_2_clinical_manager: [
    "clinical_manager",
    "clinical_supervisor",
    "director_of_nursing",
    "administrator",
    "org_admin",
  ],
  tier_3_medical_director: ["medical_director", "director_of_nursing", "administrator", "org_admin"],
  tier_4_compliance_officer: ["compliance_officer", "administrator", "org_admin"],
  // tier 5 escalates to a VENDOR actor; no in-agency role stands in for it (§3.3's recipient CHECK makes
  // the row's only recipient an `external_triage_vendor` id). An in-agency actor reaches a tier-5 row
  // through the oversight roles above, which is why they are listed and the clinical ones are not.
  tier_5_external: ["administrator", "org_admin", "compliance_officer"],
};

/**
 * §6 / §7.3 — M3 role key → the §3.2 `oncall_shift_discipline` band the disposition matrix is keyed on.
 *
 * WHY A ROLE MAP AND NOT AN M40 READ (the M16-T06 argument, unchanged): no bound seam publishes a
 * WORKFORCE discipline. M3's `RoleGrant.roleKey` is the platform's one authority-derivation input, read
 * here through the role keys M2 already assembled onto the request context. A role key nobody granted
 * contributes nothing, and an actor whose keys evidence NO band resolves to `null` — which the disposition
 * handler treats as no scope at all.
 */
export const TRIAGE_DISCIPLINE_FOR_ROLE_KEY: Readonly<Record<string, TriageActorDiscipline>> = {
  medical_director: "medical_director",
  clinical_supervisor: "supervisor",
  clinical_manager: "supervisor",
  director_of_nursing: "supervisor",
  administrator: "supervisor",
  org_admin: "supervisor",
  triage_nurse: "clinical_rn",
  registered_nurse: "clinical_rn",
  rn_case_manager: "clinical_rn",
  nurse_practitioner: "clinical_rn",
  licensed_practical_nurse: "clinical_lpn",
  lpn: "clinical_lpn",
  msw: "msw",
  medical_social_worker: "msw",
  social_worker: "msw",
  chaplain: "chaplain",
  spiritual_care_counselor: "chaplain",
  external_triage_operator: "external",
};

/** §7.3's ladder, strongest first — the order {@link triageDisciplineForRoleKeys} resolves ties by. */
const DISCIPLINE_STRENGTH: readonly TriageActorDiscipline[] = [
  "medical_director",
  "supervisor",
  "clinical_rn",
  "clinical_lpn",
  "msw",
  "chaplain",
  "external",
];

/**
 * The §7.3 discipline band a role-key set evidences, or `null` when none does.
 *
 * The STRONGEST band wins. An RN who also holds the chaplain role must not have their disposition scope
 * silently narrowed to `caregiver_education_only` because the map happened to see `chaplain` first — the
 * §7.3 gate is about what the actor MAY do, and a clinician does not lose their licence by volunteering.
 */
export function triageDisciplineForRoleKeys(
  roleKeys: readonly string[],
): TriageActorDiscipline | null {
  let best: TriageActorDiscipline | null = null;
  for (const key of roleKeys) {
    const band = TRIAGE_DISCIPLINE_FOR_ROLE_KEY[key];
    if (band === undefined) continue;
    if (best === null || DISCIPLINE_STRENGTH.indexOf(band) < DISCIPLINE_STRENGTH.indexOf(best)) {
      best = band;
    }
  }
  return best;
}

/** M2 session classes that are an external triage VENDOR operator's session (ADR-0026 / §8.3.1). */
export const VENDOR_SESSION_CLASSES = ["external_triage_vendor", "external_triage_operator"] as const;

/** M2 session classes that are a patient/caregiver PORTAL session (§4.1 row 36). */
export const PORTAL_SESSION_CLASSES = [
  "patient_portal",
  "caregiver_portal",
  "bereaved_portal",
] as const;

// ── the facts the six predicates decide over ─────────────────────────────────────────────────────────

/** The `triage_call` facts the per-call predicates read. */
export interface TriageCallAbacFacts {
  readonly organizationId: string;
  readonly triageCallId: string;
  readonly providerEntityId: string;
  /** NULL until the caller is matched to a served person (§3.3) — a call with no patient has no caseload. */
  readonly patientId: string | null;
  readonly onCallShiftId: string;
}

/** The `on_call_shift` facts `oncall_eligible` / `external_triage_actor` read. */
export interface OnCallShiftAbacFacts {
  readonly organizationId: string;
  readonly shiftId: string;
  readonly providerEntityId: string;
  readonly discipline: OncallShiftDiscipline;
  readonly primaryOnCallMembershipId: MembershipId | null;
  readonly backupMembershipId: MembershipId | null;
  readonly externalActorId: string | null;
}

/** The `triage_escalation` facts the two escalation predicates read. */
export interface TriageEscalationAbacFacts {
  readonly organizationId: string;
  readonly escalationId: string;
  readonly tier: TriageEscalationTier;
  readonly escalatedToMembershipId: MembershipId | null;
  readonly escalatedToExternalActorId: string | null;
}

/** The read surface M19's predicates resolve against (Drizzle in prod; in-memory in tests). */
export interface OncallAbacResolver {
  /** Call facts for a `triage_call` id, or null when absent / cross-tenant (fail-closed). */
  loadCall(orgId: string, triageCallId: string): Promise<TriageCallAbacFacts | null>;
  /** Shift facts for an `on_call_shift` id, or null when absent / cross-tenant. */
  loadShift(orgId: string, shiftId: string): Promise<OnCallShiftAbacFacts | null>;
  /** Escalation facts for a `triage_escalation` id, or null when absent / cross-tenant. */
  loadEscalation(orgId: string, escalationId: string): Promise<TriageEscalationAbacFacts | null>;
  /**
   * §4.7(a) — is this membership the primary or backup on an `on_call_shift` that is ACTIVE and covers
   * `asOfIso`? `null` means the roster could not be read at all, which DENIES; `false` means it was read
   * and the membership is not on it. The two must stay distinguishable (the M19-T04 finding) so a
   * transient DB error is never recorded as "this nurse was not on call".
   */
  activeShiftForMembership(input: {
    readonly orgId: string;
    readonly membershipId: string;
    readonly asOfIso: string;
    /** When given, the shift must also cover this ProviderEntity (the per-call check). */
    readonly providerEntityId?: string;
  }): Promise<boolean | null>;
  /** The enabled M3 role keys a membership holds, or null when unresolvable (denies). */
  roleKeysOf(orgId: string, membershipId: string): Promise<readonly string[] | null>;
}

/** A resolver that denies everything — the shape a boot-without-DB path binds (fail-closed, never open). */
export const denyStubOncallAbacResolver: OncallAbacResolver = {
  async loadCall() {
    return null;
  },
  async loadShift() {
    return null;
  },
  async loadEscalation() {
    return null;
  },
  async activeShiftForMembership() {
    return null;
  },
  async roleKeysOf() {
    return null;
  },
};

// ── the cross-module reads the predicates make (through the M1 registry, never a schema import) ──────

/** The M5 / M17 / M39 facts the predicates need, injectable so §9.1 unit-tests the RULES with no seams. */
export interface OncallAbacPorts {
  /** M5 `CaseloadProvider.isInCaseload`. Throwing / unbound ⇒ `false` (fail-closed). */
  isInCaseload(input: {
    organizationId: string;
    userId: string;
    patientId: string;
  }): Promise<boolean>;
  /** M17 `VisitAssignmentReader.tonightsOnCallRoster`. `null` ⇒ unreadable ⇒ this PATH contributes nothing. */
  tonightsOnCallRoster(
    orgId: string,
    asOfIso: string,
  ): Promise<readonly { membershipId: string; providerEntityId: string }[] | null>;
  /** M39 `ConsentEvaluator` — is `family_caregiver_access` satisfied for this patient + session? */
  familyCaregiverAccessActive(input: {
    organizationId: string;
    patientId: string;
    sessionClass: string;
  }): Promise<boolean>;
}

/** The M39 surface M19 calls — structurally typed so no `@wardenx/consent` import edge is taken (M16 §7.13). */
interface ConsentEvaluatorShape {
  evaluate(args: {
    organizationId: string;
    patientId: string;
    consentType: string;
    sessionContext: { sessionClass: string };
    callerModule: string;
    callerRoute?: string;
  }): Promise<{ allowed: boolean }>;
}

/** The M17 surface the roster path calls. */
interface VisitAssignmentReaderShape {
  tonightsOnCallRoster(
    orgId: string,
    asOfIso: string,
  ): Promise<readonly { membershipId: string; providerEntityId: string }[]>;
}

/**
 * The production ports — every seam resolved LAZILY at call time through the M1 registry, so registration
 * order is irrelevant and an unregistered seam denies at its own deny-stub rather than at boot.
 */
export const seamOncallAbacPorts: OncallAbacPorts = {
  async isInCaseload(input) {
    try {
      return await getSeam("CaseloadProvider").isInCaseload(input);
    } catch {
      return false; // an unreadable caseload is not a caseload the actor is on
    }
  },
  async tonightsOnCallRoster(orgId, asOfIso) {
    try {
      const reader = getSeam("VisitAssignmentReader") as unknown as VisitAssignmentReaderShape;
      return await reader.tonightsOnCallRoster(orgId, asOfIso);
    } catch {
      return null; // §2.7 class D-C: M17 unreadable → this PATH is silent, the shift path still answers
    }
  },
  async familyCaregiverAccessActive({ organizationId, patientId, sessionClass }) {
    try {
      const evaluator = getSeam("ConsentEvaluator") as ConsentEvaluatorShape;
      const verdict = await evaluator.evaluate({
        organizationId,
        patientId,
        consentType: "family_caregiver_access",
        sessionContext: { sessionClass },
        callerModule: "m19",
      });
      return verdict.allowed === true;
    } catch {
      return false; // §8.2 — an unbound / erroring M39 DENIES the portal read
    }
  },
};

/** Deps for M19's §4.7 predicate resolvers. */
export interface OncallAbacDeps {
  readonly resolver: OncallAbacResolver;
  readonly ports?: OncallAbacPorts;
  /** Injected clock (the `asOfIso` the shift/roster paths compare against). */
  readonly now?: () => Date;
}

const targetStr = (target: AbacTarget, ...fields: string[]): string | null => {
  for (const field of fields) {
    const value = target[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
};

/** The actor's ACTIVE membership id (M2 assembles it onto `attributes`); null when absent (fail-closed). */
export function membershipIdOf(context: AbacContext): string | null {
  const value = context.attributes.membershipId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The SERVER-assembled session class (M2). Never a header, body or query field. */
export function sessionClassOf(context: AbacContext): string {
  const value = context.attributes.sessionClass;
  return typeof value === "string" && value.length > 0 ? value : "staff";
}

/**
 * The vendor identity a vendor-class session carries (`external_triage_vendor.id`), or null.
 *
 * §8.3.1's spoofing control is that this is a claim on the M2-verified session, not a request field: the
 * whole predicate is worthless if a staff caller can name a vendor id in a body and be scoped to its calls.
 * Reading it only from `context.attributes` — which `requireAbac` assembles from the session — is what
 * makes that impossible rather than merely discouraged.
 */
export function externalActorIdOf(context: AbacContext): string | null {
  const value = context.attributes.externalActorId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

const holdsAny = (roleKeys: readonly string[], allowed: readonly string[]): boolean =>
  roleKeys.some((key) => allowed.includes(key));

/**
 * The role keys of the acting subject. The request CONTEXT wins when M2 already assembled them (no DB
 * round-trip per guarded route); otherwise the resolver answers, and an unreadable grant set is `null`,
 * which denies.
 */
async function roleKeysFor(
  resolver: OncallAbacResolver,
  context: AbacContext,
): Promise<readonly string[] | null> {
  if (context.roles.length > 0) return context.roles;
  const membershipId = membershipIdOf(context);
  if (membershipId === null) return null;
  try {
    return await resolver.roleKeysOf(context.organizationId, membershipId);
  } catch {
    return null;
  }
}

// ── the pure rules (unit-testable with no resolver, no seams, no clock) ──────────────────────────────

/**
 * §4.7 `oncall_eligible`, decided over already-resolved facts.
 *
 * The three paths are evaluated in the order §4.7 lists them, and that order is not cosmetic: the SHIFT
 * path is the cheapest and the most specific, the ROLE path never needs a roster read, and the M17 roster
 * path is last because it is the one that can be unreadable. Reordering would make a supervisor's access
 * depend on M17 being up.
 */
export function decideOnCallEligible(input: {
  readonly onActiveShift: boolean | null;
  readonly roleKeys: readonly string[] | null;
  readonly rosterNames: boolean | null;
}): boolean {
  if (input.onActiveShift === true) return true; // (a)
  if (input.roleKeys !== null && holdsAny(input.roleKeys, ONCALL_OVERSIGHT_ROLES)) return true; // (b)
  return input.rosterNames === true; // (c) — `null` (unreadable) is NOT eligibility
}

/** §4.7 `escalation_recipient_scope`, decided over already-resolved role keys. */
export function decideEscalationRecipientScope(roleKeys: readonly string[] | null): boolean {
  return roleKeys !== null && holdsAny(roleKeys, ESCALATION_TIER_ROLES);
}

/**
 * §4.7 `escalation_recipient`, decided over already-resolved facts.
 *
 * The NAMED recipient is checked first and separately from the tier-role fallback: §7.2's medical director
 * is escalated to BY NAME, and a tier-role check that ran first would let any administrator acknowledge
 * the page on their behalf — which is exactly the acknowledgement §2.2.4 exists to make attributable.
 */
export function decideEscalationRecipient(input: {
  readonly facts: TriageEscalationAbacFacts;
  readonly membershipId: string | null;
  readonly roleKeys: readonly string[] | null;
  readonly externalActorId: string | null;
}): boolean {
  const { facts } = input;
  if (facts.escalatedToMembershipId !== null && facts.escalatedToMembershipId === input.membershipId) {
    return true;
  }
  // A tier-5 row escalates to a vendor actor; that vendor's own session may acknowledge it.
  if (
    facts.escalatedToExternalActorId !== null &&
    input.externalActorId !== null &&
    facts.escalatedToExternalActorId === input.externalActorId
  ) {
    return true;
  }
  if (input.roleKeys === null) return false;
  return holdsAny(input.roleKeys, ROLES_BY_ESCALATION_TIER[facts.tier]);
}

/**
 * §4.7 `external_triage_actor`, decided over already-resolved facts.
 *
 * Both halves must hold: the SESSION must carry a vendor identity, and the call's own shift must be the
 * one that vendor covers. A vendor session with no shift match sees nothing; a staff session with a
 * stray attribute is refused by the session-class check before the ids are ever compared.
 */
export function decideExternalTriageActor(input: {
  readonly sessionClass: string;
  readonly sessionExternalActorId: string | null;
  readonly shift: OnCallShiftAbacFacts | null;
}): boolean {
  if (!(VENDOR_SESSION_CLASSES as readonly string[]).includes(input.sessionClass)) return false;
  if (input.sessionExternalActorId === null) return false;
  if (input.shift === null) return false;
  if (input.shift.externalActorId === null) return false;
  return input.shift.externalActorId === input.sessionExternalActorId;
}

// ── the registry closures ────────────────────────────────────────────────────────────────────────────

/**
 * Build M19's six §4.7 predicate resolvers over injected deps (pure factory — unit-tested against a fresh
 * registry; the boot path registers them via {@link registerOncallAbacPredicates}).
 */
export function buildOncallAbacPredicates(
  deps: OncallAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  const ports = deps.ports ?? seamOncallAbacPorts;
  const now = deps.now ?? (() => new Date());

  /** Shared by `oncall_eligible` and the supervisor arm of `triage_call_owner_or_supervisor`. */
  const oncallEligibleFor = async (
    context: AbacContext,
    providerEntityId: string | null,
  ): Promise<boolean> => {
    const membershipId = membershipIdOf(context);
    const asOfIso = now().toISOString();
    const roleKeys = await roleKeysFor(resolver, context);

    let onActiveShift: boolean | null = null;
    if (membershipId !== null) {
      try {
        onActiveShift = await resolver.activeShiftForMembership({
          orgId: context.organizationId,
          membershipId,
          asOfIso,
          ...(providerEntityId !== null ? { providerEntityId } : {}),
        });
      } catch {
        onActiveShift = null;
      }
    }

    // Path (c) is only consulted when (a) and (b) have not already answered — it is the one read that can
    // be slow, and §4.7 lists it as the fallback.
    if (decideOnCallEligible({ onActiveShift, roleKeys, rosterNames: null })) return true;
    if (membershipId === null) return false;
    const roster = await ports.tonightsOnCallRoster(context.organizationId, asOfIso);
    const rosterNames =
      roster === null
        ? null
        : roster.some(
            (r) =>
              r.membershipId === membershipId &&
              (providerEntityId === null || r.providerEntityId === providerEntityId),
          );
    return decideOnCallEligible({ onActiveShift, roleKeys, rosterNames });
  };

  return {
    /** §4.1 row 1 — `POST /triage-calls`. The target names the PE the call is being opened under. */
    oncall_eligible: async (context, target) => {
      if (!context.organizationId) return false;
      return oncallEligibleFor(context, targetStr(target, "providerEntityId"));
    },

    /** §4.1 rows 3-15 — the per-call staff surface. */
    triage_call_owner_or_supervisor: async (context, target) => {
      if (!context.organizationId) return false;
      const triageCallId = targetStr(target, "triageCallId", "id");
      if (triageCallId === null) return false;
      const facts = await resolver.loadCall(context.organizationId, triageCallId).catch(() => null);
      if (facts === null) return false; // absent / cross-tenant / unreadable → deny (and the route 404s)

      // Caseload first: it is the common case and needs no roster read.
      if (facts.patientId !== null && context.userId) {
        const inCaseload = await ports.isInCaseload({
          organizationId: context.organizationId,
          userId: context.userId,
          patientId: facts.patientId,
        });
        if (inCaseload) return true;
      }
      return oncallEligibleFor(context, facts.providerEntityId);
    },

    /** §4.7 / §7.5 — the vendor-session arm of the SAME per-call rows (see decision 1 in the header). */
    external_triage_actor: async (context, target) => {
      if (!context.organizationId) return false;
      const sessionExternalActorId = externalActorIdOf(context);
      const sessionClass = sessionClassOf(context);
      // Cheap refusals BEFORE any read, so a staff session cannot probe call ids through this predicate.
      if (!decideExternalTriageActor({ sessionClass, sessionExternalActorId, shift: null })) {
        if (sessionExternalActorId === null) return false;
        if (!(VENDOR_SESSION_CLASSES as readonly string[]).includes(sessionClass)) return false;
      }
      const triageCallId = targetStr(target, "triageCallId", "id");
      if (triageCallId === null) return false;
      const call = await resolver.loadCall(context.organizationId, triageCallId).catch(() => null);
      if (call === null) return false;
      const shift = await resolver
        .loadShift(context.organizationId, call.onCallShiftId)
        .catch(() => null);
      return decideExternalTriageActor({ sessionClass, sessionExternalActorId, shift });
    },

    /** §4.1 row 16 — the escalation inbox. No target row exists yet; the actor's tier band decides. */
    escalation_recipient_scope: async (context) => {
      if (!context.organizationId) return false;
      return decideEscalationRecipientScope(await roleKeysFor(resolver, context));
    },

    /** §4.1 rows 17-18 — acknowledge / resolve one escalation. */
    escalation_recipient: async (context, target) => {
      if (!context.organizationId) return false;
      const escalationId = targetStr(target, "escalationId", "id");
      if (escalationId === null) return false;
      const facts = await resolver
        .loadEscalation(context.organizationId, escalationId)
        .catch(() => null);
      if (facts === null) return false;
      return decideEscalationRecipient({
        facts,
        membershipId: membershipIdOf(context),
        roleKeys: await roleKeysFor(resolver, context),
        externalActorId: externalActorIdOf(context),
      });
    },

    /**
     * §4.1 row 36 — the M31 portal read.
     *
     * The consent is evaluated against the PATIENT THE TARGET NAMES, and the route's `getTarget` takes
     * that patient id from the portal SESSION, never from the query string (§8.3.1's threat (b): a
     * caregiver with a valid session naming another patient's id). The predicate additionally refuses any
     * session class that is not a portal one, so a staff session cannot reach the lay-language projection
     * and thereby bypass the clinical routes' caseload gate.
     */
    portal_session_consent_active: async (context, target) => {
      if (!context.organizationId) return false;
      if (!(PORTAL_SESSION_CLASSES as readonly string[]).includes(sessionClassOf(context))) {
        return false;
      }
      const patientId = targetStr(target, "patientId");
      if (patientId === null) return false;
      return ports.familyCaregiverAccessActive({
        organizationId: context.organizationId,
        patientId,
        sessionClass: sessionClassOf(context),
      });
    },
  };
}

/**
 * Register M19's six §4.7 ABAC predicate resolvers into M3's shared registry (M19-T07; idempotent). Call at
 * boot after the M19 route services are constructed (the resolver reads the same tables). Re-boot (tests)
 * skips already-registered names (single-owner / no-clear).
 */
export function registerOncallAbacPredicates(deps: OncallAbacDeps): void {
  const predicates = buildOncallAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    if (abacRegistry.has(name)) continue;
    registerPredicate(name, predicate);
  }
}
