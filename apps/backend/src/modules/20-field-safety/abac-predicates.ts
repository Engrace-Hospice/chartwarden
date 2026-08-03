// apps/backend/src/modules/20-field-safety/abac-predicates.ts — M20-T06 (§4.7 / §8.2).
//
// The SIX named ABAC predicate resolvers M20 registers into M3's named-predicate registry. Each is a typed
// `(context, target) => boolean` evaluated server-side AFTER RBAC passes; every subject fact is loaded
// through the injected {@link SafetyAbacResolver} (org-scoped, RLS-backstopped) — never read off the
// request body.
//
//   clinician_self               — §4.7: the acting membership IS the subject of the row
//        (`posted_by_membership_id`, or `affected_clinician_membership_id` for incidents, or
//        `clinician_membership_id` for a consent row).
//   supervises_clinician         — §4.7: an ACTIVE `safety_supervisor_subscription` pairs the session's
//        membership with the target's clinician, evaluated through the §4.3 scope rules.
//   safety_supervisor_or_above   — §4.7: the session's role set intersects {Clinical Supervisor, DON,
//        Compliance Officer, Owner}.
//   incident_subject_or_supervisor — §4.7: the disjunction of `clinician_self` (as affected clinician)
//        and `safety_supervisor_or_above`.
//   active_sos_responder         — §4.7: the session supervises the alert's clinician AND the alert is in
//        `acknowledging | escalation_tier_*`; OR (after hours) the session is on M19's on-call roster for
//        the alert's ProviderEntity.
//   field_eligible_for_sos       — §4.7: the session's discipline is in the field-eligible set.
//
// TWO NAMES §4.7 LISTS THAT M20 DOES NOT REGISTER, AND WHY:
//
//   `caseload_or_scope` is M7's. §4.7 itself says "reused from M5/M17"; M20 binds it BY NAME on the
//   dashboard row (routes/guards.ts). A shared predicate is keyed on its OWNER's target shape (the
//   M15-T06 lesson), so M20's target for it names `patientId` or nothing at all.
//
//   `org_scope` IS M3's INTRINSIC `inOrg`, VERBATIM. §4.7 defines it as "session.organization_id ===
//   target.organization_id", which is the rule `inOrg` already implements and the platform already
//   registers. Registering a second name for the same rule would create two predicates that must never
//   disagree and would satisfy `arch:abac-predicates` either way; the two §4.1 `org_scope` cells
//   (`GET /policy`, `GET /high-risk-areas`) therefore bind `inOrg`. This is a DELIBERATE non-registration,
//   not an omission — the difference matters because the gate cannot tell them apart.
//
// ── THE FAIL DIRECTION IS UNIFORM, AND ONE READ IS THREE-VALUED ──────────────────────────────────────
//
// Every one of the six is an AUTHORIZATION read: an unreadable resolver, an unknown target, an absent
// row, a cross-tenant id and a thrown error all DENY. §2.4's "a coverage gap must ALERT rather than
// block" governs the WATCHDOG — it is not a licence to let an unknown actor acknowledge a life-safety
// alert.
//
// The ONE method that does not collapse its error into a boolean is `onCallForProviderEntity`, and the
// reason is the M20-T04 rule carried forward: `[]` from M19's `OnCallProvider` is a REAL coverage gap and
// `null` is "M19 did not answer". `decideActiveSosResponder` treats `null` as no-answer and lets the
// SUBSCRIPTION arm still speak — so a supervisor who is subscribed to this clinician can still
// acknowledge a 3 a.m. SOS while M19 is down, and an on-call nurse who has no subscription is still
// refused, because she has no other path and guessing in her favour would let any session that reached
// this route acknowledge any alert.
//
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests) guards
// on `abacRegistry.has`.
import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@wardenx/auth";
import type {
  IsoInstant,
  MembershipId,
  OrgId,
  ProviderEntityId,
  SafetySosLifecycleState,
  SafetySubscriptionScopeKind,
} from "@wardenx/types";
import { getSeam } from "../../bootstrap/index";
import { subscriptionScopeCovers } from "./lifecycle/coverage-gap";

/** The §4.7 predicate names M20 OWNS (registered into M3). Single-owner across the platform registry. */
export const M20_ABAC_PREDICATES = [
  "clinician_self",
  "supervises_clinician",
  "safety_supervisor_or_above",
  "incident_subject_or_supervisor",
  "active_sos_responder",
  "field_eligible_for_sos",
] as const;

export type M20RegisteredAbacPredicate = (typeof M20_ABAC_PREDICATES)[number];

/**
 * §4.7 `safety_supervisor_or_above` — the role keys that carry safety-oversight authority BY OFFICE.
 *
 * §4.7's own list is {Clinical Supervisor, DON, Compliance Officer, Owner}. `clinical_manager`,
 * `administrator` and `org_admin` are the M3 role-template spellings of the same offices (`templates.ts`
 * has no `owner` key — the administrator/org-admin templates are what an owner holds), and omitting them
 * would make §6's "Clin Supv / DON / Comp Off" columns unreachable for the very roles §6 grants the
 * widest safety access. This is the M19 `ONCALL_OVERSIGHT_ROLES` argument, unchanged.
 */
export const SAFETY_OVERSIGHT_ROLES = [
  "clinical_supervisor",
  "clinical_manager",
  "director_of_nursing",
  "compliance_officer",
  "administrator",
  "org_admin",
] as const;

/**
 * §4.7 `field_eligible_for_sos` — the discipline set §4.7 names, expressed as M3 ROLE KEYS.
 *
 * WHY ROLE KEYS AND NOT A WORKFORCE DISCIPLINE (the M16-T06 / M19-T07 argument, unchanged): no bound
 * seam publishes a workforce discipline. M3's `RoleGrant.roleKey` is the platform's one
 * authority-derivation input, read here through the role keys M2 already assembled onto the request
 * context. §4.7's `scheduler_in_field` has no template of its own; `scheduler` is the closest key the
 * platform actually grants, and a discipline nobody can hold is a discipline that never reaches the SOS
 * button.
 *
 * NOTE WHAT THIS PREDICATE DOES **NOT** DO. It gates who may PRESS the button, which is §4.6's
 * "field-eligible discipline set" for `safety.sos.raise`. It is emphatically NOT a gate on the alert
 * fanning out: once a row exists, M20-F05 / S13 make the fan-out unconditional. Anyone who reads this as
 * "the SOS is refused unless X" has read it backwards — the refusal happens before a press is recorded at
 * all, and §6 grants the key to every field discipline precisely so it never bites in the field.
 */
export const FIELD_ELIGIBLE_ROLE_KEYS = [
  "registered_nurse",
  "rn_case_manager",
  "nurse_practitioner",
  "triage_nurse",
  "licensed_practical_nurse",
  "lpn",
  "certified_home_health_aide",
  "chha",
  "home_health_aide",
  "msw",
  "medical_social_worker",
  "social_worker",
  "chaplain",
  "spiritual_care_counselor",
  "volunteer",
  "volunteer_coordinator",
  "scheduler",
] as const;

/**
 * §4.7 / §2.2.2 — the alert states in which a responder is ACTIVE.
 *
 * §4.7 spells "`acknowledging` | `escalation_tier_*`". `emergency_terminus` is INCLUDED here for the same
 * reason migration 0110's SLA index includes it (M20-T02) and the D6 stream includes it (M20-T03): it is
 * an OPEN state whose entire purpose is to keep paging until a human answers, and a predicate that
 * excluded it would 403 the one person trying to acknowledge the alert nobody has answered — turning the
 * terminus into the permanent silence it exists to end.
 *
 * `acknowledged` / `resolving` are NOT here: by then a responder has been recorded, and the routes that
 * bind this predicate (acknowledge, resolve, the during-SOS coordinate read) each check the machine's own
 * transition table anyway. `cancel_window_open` and `raised` are not here either — nobody is responding to
 * a press that may still be stood down.
 */
export const ACTIVE_SOS_RESPONDER_STATES = [
  "acknowledging",
  "escalation_tier_1",
  "escalation_tier_2",
  "escalation_tier_3",
  "emergency_terminus",
] as const satisfies readonly SafetySosLifecycleState[];

// ── the facts the six predicates decide over ─────────────────────────────────────────────────────────

/** The `safety_sos_alert` facts the SOS predicates read. */
export interface SafetySosAbacFacts {
  readonly organizationId: OrgId;
  readonly sosAlertId: string;
  readonly providerEntityId: ProviderEntityId;
  readonly postedByMembershipId: MembershipId;
  readonly lifecycleState: SafetySosLifecycleState;
}

/** The `safety_check_in` / `safety_check_in_schedule` facts the check-in rows carry. */
export interface SafetyCheckInAbacFacts {
  readonly organizationId: OrgId;
  readonly checkInId: string;
  readonly providerEntityId: ProviderEntityId;
  readonly clinicianMembershipId: MembershipId;
  /** §4.1 row 3 — the amendment grace is measured from here (the route enforces the 5 minutes). */
  readonly postedAt: IsoInstant;
}

/** The `safety_incident` facts the incident predicates read. */
export interface SafetyIncidentAbacFacts {
  readonly organizationId: OrgId;
  readonly incidentId: string;
  readonly providerEntityId: ProviderEntityId;
  readonly affectedClinicianMembershipId: MembershipId;
  readonly reportedByMembershipId: MembershipId;
  readonly lifecycleState: string;
}

/** One ACTIVE `safety_supervisor_subscription` row as `supervises_clinician` reads it. */
export interface SafetySubscriptionAbacFacts {
  readonly supervisorMembershipId: MembershipId;
  readonly clinicianMembershipId: MembershipId | null;
  readonly locationId: string | null;
  readonly providerEntityId: ProviderEntityId | null;
  readonly scopeKind: SafetySubscriptionScopeKind;
  readonly isVacationForwarding: boolean;
  readonly vacationForwardToMembershipId: MembershipId | null;
}

/**
 * The clinician-side scope facts a subscription is matched against.
 *
 * `locationIds` is a LIST, not a single id: M1's `membership.default_location_ids` is jsonb and a
 * traveling clinician works at several. A `location`-scoped subscription covering ANY of them covers her
 * — the same normalization the M20-T05 coverage store does, so the paging layer and the authorization
 * layer cannot disagree about which location she is in.
 */
export interface SafetyClinicianScopeFacts {
  readonly membershipId: MembershipId;
  readonly locationIds: readonly string[];
  readonly providerEntityId: ProviderEntityId | null;
}

/** The read surface M20's predicates resolve against (Drizzle in prod; in-memory in tests). */
export interface SafetyAbacResolver {
  /** SOS facts for an id, or null when absent / cross-tenant / unreadable (fail-closed). */
  loadSosAlert(orgId: string, sosAlertId: string): Promise<SafetySosAbacFacts | null>;
  /** Check-in facts for an id, or null. */
  loadCheckIn(orgId: string, checkInId: string): Promise<SafetyCheckInAbacFacts | null>;
  /** Incident facts for an id, or null. */
  loadIncident(orgId: string, incidentId: string): Promise<SafetyIncidentAbacFacts | null>;
  /** The ACTIVE subscription rows naming this supervisor. `null` ⇒ unreadable (denies). */
  subscriptionsForSupervisor(
    orgId: string,
    supervisorMembershipId: string,
  ): Promise<readonly SafetySubscriptionAbacFacts[] | null>;
  /** The clinician's own scope facts (their location + default PE), or null. */
  clinicianScope(orgId: string, membershipId: string): Promise<SafetyClinicianScopeFacts | null>;
  /** The enabled M3 role keys a membership holds, or null when unresolvable (denies). */
  roleKeysOf(orgId: string, membershipId: string): Promise<readonly string[] | null>;
}

/** A resolver that denies everything — the shape a boot-without-DB path binds (fail-closed, never open). */
export const denyStubSafetyAbacResolver: SafetyAbacResolver = {
  async loadSosAlert() {
    return null;
  },
  async loadCheckIn() {
    return null;
  },
  async loadIncident() {
    return null;
  },
  async subscriptionsForSupervisor() {
    return null;
  },
  async clinicianScope() {
    return null;
  },
  async roleKeysOf() {
    return null;
  },
};

// ── the cross-module read `active_sos_responder` makes (through the M1 registry, never a schema import) ──

/** The M19 reach `active_sos_responder` takes, injectable so §9.1 unit-tests the RULES with no seams. */
export interface SafetyAbacPorts {
  /**
   * M19 `OnCallProvider.currentOnCallActors` — the memberships covering a PE right now.
   *
   * THREE-VALUED (see the module header): `null` is "M19 did not answer", `[]` is "nobody is on call",
   * and a populated array is the roster. Collapsing the first two would make an M19 outage read as a
   * genuine coverage gap and refuse a nurse who IS on call.
   */
  onCallForProviderEntity(
    orgId: string,
    providerEntityId: string,
    asOfIso: string,
  ): Promise<readonly MembershipId[] | null>;
}

/** The M19 surface this file calls — structurally typed so no `@wardenx/types` seam import edge is taken. */
interface OnCallProviderShape {
  currentOnCallActors(
    orgId: string,
    providerEntityId: string,
    asOfIso: string,
  ): Promise<readonly { readonly kind: string; readonly membershipId?: string }[]>;
}

/** The production ports — the seam is resolved LAZILY at call time through the M1 registry, so
 *  registration order is irrelevant and an unregistered seam denies at its own deny-stub. */
export const seamSafetyAbacPorts: SafetyAbacPorts = {
  async onCallForProviderEntity(orgId, providerEntityId, asOfIso) {
    try {
      const provider = getSeam("OnCallProvider") as unknown as OnCallProviderShape;
      const actors = await provider.currentOnCallActors(orgId, providerEntityId, asOfIso);
      // The vendor arm of `OnCallActor` carries NO membership (M19-T01 made it structurally incapable of
      // one), so it contributes nothing to a MEMBERSHIP-keyed authorization question. It is dropped here
      // rather than treated as an unreadable roster: a vendor-covered night is a real, readable answer
      // that simply names nobody this predicate can match.
      return actors
        .filter((a) => typeof a.membershipId === "string" && a.membershipId.length > 0)
        .map((a) => a.membershipId as MembershipId);
    } catch {
      return null; // "M19 did not answer" — never `[]`, which is a real coverage gap
    }
  },
};

/** Deps for M20's §4.7 predicate resolvers. */
export interface SafetyAbacDeps {
  readonly resolver: SafetyAbacResolver;
  readonly ports?: SafetyAbacPorts;
  /** Injected clock (the `asOfIso` the on-call roster path compares against). */
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

const holdsAny = (roleKeys: readonly string[], allowed: readonly string[]): boolean =>
  roleKeys.some((key) => allowed.includes(key));

/**
 * The role keys of the acting subject. The request CONTEXT wins when M2 already assembled them (no DB
 * round-trip per guarded route); otherwise the resolver answers, and an unreadable grant set is `null`,
 * which denies.
 */
async function roleKeysFor(
  resolver: SafetyAbacResolver,
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

/** §4.7 `safety_supervisor_or_above`, decided over already-resolved role keys. */
export function decideSafetySupervisorOrAbove(roleKeys: readonly string[] | null): boolean {
  return roleKeys !== null && holdsAny(roleKeys, SAFETY_OVERSIGHT_ROLES);
}

/** §4.7 `field_eligible_for_sos`, decided over already-resolved role keys. */
export function decideFieldEligibleForSos(roleKeys: readonly string[] | null): boolean {
  return roleKeys !== null && holdsAny(roleKeys, FIELD_ELIGIBLE_ROLE_KEYS);
}

/**
 * §2.2.5 / §4.3 — does one subscription row's SCOPE cover this clinician?
 *
 * Delegates to `subscriptionScopeCovers` (../lifecycle/coverage-gap), which is the ONE place D8's four-way
 * scope layering lives. The alert-kind filter that `subscriptionCovers` adds on top is deliberately NOT
 * applied here — see that function's doc-comment: a supervisor subscribed only to `overdue` still watches
 * this clinician, and refusing her the SOS she is looking at because her row does not PAGE on `sos` would
 * be an authorization rule nobody wrote.
 *
 * A DEACTIVATED or SUPERSEDED row never reaches here: the resolver filters them in SQL, because "is this
 * supervisor watching her" must not be answerable by a subscription that ended last March.
 */
export function subscriptionCoversClinician(
  subscription: SafetySubscriptionAbacFacts,
  clinician: SafetyClinicianScopeFacts,
): boolean {
  return subscriptionScopeCovers(
    {
      scopeKind: subscription.scopeKind,
      clinicianMembershipId: subscription.clinicianMembershipId,
      locationId: subscription.locationId,
      providerEntityId: subscription.providerEntityId,
    },
    {
      membershipId: clinician.membershipId,
      locationIds: clinician.locationIds,
      providerEntityId: clinician.providerEntityId ?? "",
    },
  );
}

/**
 * §4.7 `supervises_clinician`, decided over already-resolved facts.
 *
 * VACATION FORWARDING IS READ IN BOTH DIRECTIONS, and getting it one-way is the bug. A supervisor whose
 * row forwards to somebody else is on a plane — she is still ON the subscription and §4.3's own note is
 * about DELIVERY, not authority, so she keeps read access to the clinician whose coverage she arranged.
 * The FORWARD TARGET must ALSO pass: she is the one being paged tonight, and a predicate that refused her
 * would page a supervisor who then gets a 403 on the alert she was woken for. Both arms are therefore
 * evaluated, and the second is why the resolver loads subscriptions by supervisor AND by forward target.
 */
export function decideSupervisesClinician(input: {
  readonly subscriptions: readonly SafetySubscriptionAbacFacts[] | null;
  readonly actingMembershipId: string | null;
  readonly clinician: SafetyClinicianScopeFacts | null;
}): boolean {
  if (input.subscriptions === null || input.clinician === null) return false;
  if (input.actingMembershipId === null) return false;
  // A supervisor never "supervises" herself through a subscription row — §3.3's `m20_sss_no_self_
  // supervision` CHECK forbids the row — but the SELF case is `clinician_self`'s to answer, and the two
  // predicates are ORed at the route, so returning false here loses nothing.
  return input.subscriptions.some((s) => {
    const isSubscriber = s.supervisorMembershipId === input.actingMembershipId;
    const isForwardTarget =
      s.isVacationForwarding &&
      s.vacationForwardToMembershipId !== null &&
      s.vacationForwardToMembershipId === input.actingMembershipId;
    if (!isSubscriber && !isForwardTarget) return false;
    return subscriptionCoversClinician(s, input.clinician as SafetyClinicianScopeFacts);
  });
}

/**
 * §4.7 `active_sos_responder`, decided over already-resolved facts.
 *
 * The two arms are a DISJUNCTION and the second is the after-hours one (D14). Both require the alert to
 * be in an actively-escalating state — a responder to a `resolved` alert is a reader, not a responder,
 * and `acknowledge`/`resolve` would be refused by the machine anyway; refusing here as well means the
 * route answers 403 rather than letting a caller probe the lifecycle through a 409.
 */
export function decideActiveSosResponder(input: {
  readonly alert: SafetySosAbacFacts | null;
  readonly supervises: boolean;
  /** `null` = M19 did not answer (see the module header); `[]` = nobody is on call. */
  readonly onCallMemberships: readonly MembershipId[] | null;
  readonly actingMembershipId: string | null;
}): boolean {
  const { alert } = input;
  if (alert === null) return false;
  if (!(ACTIVE_SOS_RESPONDER_STATES as readonly string[]).includes(alert.lifecycleState)) {
    return false;
  }
  if (input.supervises) return true;
  if (input.onCallMemberships === null || input.actingMembershipId === null) return false;
  return input.onCallMemberships.includes(input.actingMembershipId as MembershipId);
}

// ── the registry closures ────────────────────────────────────────────────────────────────────────────

/**
 * Build M20's six §4.7 predicate resolvers over injected deps (pure factory — unit-tested against a fresh
 * registry; the boot path registers them via {@link registerFieldSafetyAbacPredicates}).
 *
 * `clinician_self` is the one predicate that reads THREE different target shapes, because §4.7 defines it
 * across three tables ("`posted_by_membership_id` (or `affected_clinician_membership_id` for incidents)").
 * The route's `getTarget` names WHICH id it is handing over (`sosAlertId` / `checkInId` / `incidentId` /
 * `clinicianMembershipId`), and an unnamed target denies — a predicate that guessed which table an
 * anonymous uuid belonged to would be one probe away from telling a caller that some id, somewhere, is
 * theirs.
 */
export function buildFieldSafetyAbacPredicates(
  deps: SafetyAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  const ports = deps.ports ?? seamSafetyAbacPorts;
  const now = deps.now ?? (() => new Date());

  /** The subject membership the target names, resolved through whichever row id it carries. */
  const subjectMembershipOf = async (
    orgId: string,
    target: AbacTarget,
  ): Promise<{ membershipId: MembershipId; providerEntityId: ProviderEntityId | null } | null> => {
    const direct = targetStr(target, "clinicianMembershipId", "membershipId");
    if (direct !== null) {
      return { membershipId: direct as MembershipId, providerEntityId: null };
    }
    const sosAlertId = targetStr(target, "sosAlertId");
    if (sosAlertId !== null) {
      const alert = await resolver.loadSosAlert(orgId, sosAlertId).catch(() => null);
      return alert === null
        ? null
        : { membershipId: alert.postedByMembershipId, providerEntityId: alert.providerEntityId };
    }
    const checkInId = targetStr(target, "checkInId");
    if (checkInId !== null) {
      const checkIn = await resolver.loadCheckIn(orgId, checkInId).catch(() => null);
      return checkIn === null
        ? null
        : {
            membershipId: checkIn.clinicianMembershipId,
            providerEntityId: checkIn.providerEntityId,
          };
    }
    const incidentId = targetStr(target, "incidentId");
    if (incidentId !== null) {
      const incident = await resolver.loadIncident(orgId, incidentId).catch(() => null);
      return incident === null
        ? null
        : {
            membershipId: incident.affectedClinicianMembershipId,
            providerEntityId: incident.providerEntityId,
          };
    }
    return null;
  };

  /** Shared by `supervises_clinician` and the subscription arm of `active_sos_responder`. */
  const supervisesMembership = async (
    context: AbacContext,
    clinicianMembershipId: MembershipId,
  ): Promise<boolean> => {
    const actingMembershipId = membershipIdOf(context);
    if (actingMembershipId === null) return false;
    const [subscriptions, clinician] = await Promise.all([
      resolver
        .subscriptionsForSupervisor(context.organizationId, actingMembershipId)
        .catch(() => null),
      resolver.clinicianScope(context.organizationId, clinicianMembershipId).catch(() => null),
    ]);
    return decideSupervisesClinician({ subscriptions, actingMembershipId, clinician });
  };

  return {
    /** §4.1 rows 1-5, 6, 9, 11, 14, 27-29 — the acting membership IS the subject of the row. */
    clinician_self: async (context, target) => {
      if (!context.organizationId) return false;
      const actingMembershipId = membershipIdOf(context);
      if (actingMembershipId === null) return false;
      // A create/list route names no row (there is nothing to name yet). §4.1's `clinician_self` cell on
      // those rows means "acting AS yourself", which is true for any session that carries a membership —
      // the write path stamps the attribution column from the SAME membership (routes/actor.ts), so a
      // caller cannot post on somebody else's behalf whatever this predicate answers.
      const subject = await subjectMembershipOf(context.organizationId, target);
      if (subject === null) return Object.keys(target).length === 0;
      return subject.membershipId === actingMembershipId;
    },

    /** §4.1 rows 2, 9 — the supervisor arm of the per-row reads. */
    supervises_clinician: async (context, target) => {
      if (!context.organizationId) return false;
      const subject = await subjectMembershipOf(context.organizationId, target);
      if (subject === null) return false;
      return supervisesMembership(context, subject.membershipId);
    },

    /** §4.1 rows 10, 11, 14, 16-22, 24-26 — oversight by office. */
    safety_supervisor_or_above: async (context) => {
      if (!context.organizationId) return false;
      return decideSafetySupervisorOrAbove(await roleKeysFor(resolver, context));
    },

    /** §4.1 rows 12, 13, 15 — the incident surface. */
    incident_subject_or_supervisor: async (context, target) => {
      if (!context.organizationId) return false;
      const actingMembershipId = membershipIdOf(context);
      if (decideSafetySupervisorOrAbove(await roleKeysFor(resolver, context))) return true;
      if (actingMembershipId === null) return false;
      const subject = await subjectMembershipOf(context.organizationId, target);
      // A CREATE names no incident yet; §4.6 grants the key to "self + Clin Supv, DON", and the
      // supervisor arm already returned above, so a nameless target means "opening one on myself".
      if (subject === null) return Object.keys(target).length === 0;
      return subject.membershipId === actingMembershipId;
    },

    /** §4.1 rows 7, 8, 10 — acknowledge / resolve / read coordinates during an active alert. */
    active_sos_responder: async (context, target) => {
      if (!context.organizationId) return false;
      const sosAlertId = targetStr(target, "sosAlertId", "id");
      if (sosAlertId === null) return false;
      const alert = await resolver.loadSosAlert(context.organizationId, sosAlertId).catch(() => null);
      if (alert === null) return false;
      const supervises = await supervisesMembership(context, alert.postedByMembershipId);
      // The on-call read is only made when the subscription arm did NOT answer — it is the one read that
      // can be slow, and D14 lists it as the after-hours ADDITION to the supervisor set, not a
      // replacement for it.
      if (
        decideActiveSosResponder({
          alert,
          supervises,
          onCallMemberships: null,
          actingMembershipId: membershipIdOf(context),
        })
      ) {
        return true;
      }
      const onCallMemberships = await ports.onCallForProviderEntity(
        context.organizationId,
        alert.providerEntityId,
        now().toISOString(),
      );
      return decideActiveSosResponder({
        alert,
        supervises,
        onCallMemberships,
        actingMembershipId: membershipIdOf(context),
      });
    },

    /** §4.1 row 5 — who may PRESS the button. See {@link FIELD_ELIGIBLE_ROLE_KEYS} on what this is not. */
    field_eligible_for_sos: async (context) => {
      if (!context.organizationId) return false;
      return decideFieldEligibleForSos(await roleKeysFor(resolver, context));
    },
  };
}

/**
 * Register M20's six §4.7 ABAC predicate resolvers into M3's shared registry (M20-T06; idempotent). Call
 * at boot after the M20 route services are constructed (the resolver reads the same tables). Re-boot
 * (tests) skips already-registered names (single-owner / no-clear).
 */
export function registerFieldSafetyAbacPredicates(deps: SafetyAbacDeps): void {
  const predicates = buildFieldSafetyAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
