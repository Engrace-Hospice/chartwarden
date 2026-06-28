// apps/backend/src/modules/30-quality/abac-predicates.ts — M30 (§4.7 / §6.7).
//
// The named ABAC predicate resolvers M30 OWNS and registers into M3's named-predicate registry
// (M3 §3.4). Each is a typed `(context, target) => Promise<boolean>` evaluated server-side AFTER RBAC
// passes; M30 never authorizes by reading the request body — a resource's / actor's owner facts are
// loaded through the injected {@link ReadingM30AbacResolver} (org-scoped, RLS-backstopped). `inOrg` is
// the RE-USED M3 base predicate every M30 route also composes (M3 owns its registration); it is NOT
// re-registered here. The eleven names below are the ones M30 owns:
//
//   incident plane  — incidentVisibility, ownsIncident, assignedToIncident, abuseAllegationAccess,
//                     capVerifyAuthority (the M30-F03 / ADR-0022 separation-of-duties control)
//   QAPI plane      — ownsQapiProject, qapiCloseAuthority (D12 / V-11 two-actor PIP close)
//   SRA plane       — ownsSraCycle, sraCloseAuthority (D12 / V-12 two-actor cycle close)
//   mortality plane — assignedToMortality
//   Part 2 plane    — part2Redisclosure (M30-F14, ADR-0014 / SEC-046 — the per-row redaction filter)
//
// NB §6.7's `part2Redisclosure` was OMITTED from the pure `@wardenx/quality` `M30_ABAC_PREDICATES`
// name catalog (which lists `inOrg` + the ten operator predicates). It is added HERE so the predicate
// EXISTS (fail-closed) at boot; the pure const may want `part2Redisclosure` appended for surface
// self-description, but this slice does NOT edit packages/quality.
//
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests) guards
// on `abacRegistry.has` (the M33 `registerM33AbacPredicates` / M34 precedent). Every resolver default
// is FAIL-CLOSED: a missing / cross-tenant fact row resolves to `null`/`[]`/`false` → the predicate
// denies (and `part2Redisclosure` redacts the row). Never fails open.
import { type AbacContext, type AbacTarget, abacRegistry, registerPredicate } from "@wardenx/auth";

/**
 * The §4.7 predicate names M30 OWNS and registers into M3 (eleven). `inOrg` is excluded — it is the
 * M3-base predicate M30 routes re-use, owned + registered by M3. Single-owner across the registry.
 */
export const M30_REGISTERED_ABAC_PREDICATES = [
  "incidentVisibility",
  "ownsIncident",
  "assignedToIncident",
  "abuseAllegationAccess",
  "capVerifyAuthority",
  "ownsQapiProject",
  "qapiCloseAuthority",
  "ownsSraCycle",
  "sraCloseAuthority",
  "assignedToMortality",
  "part2Redisclosure",
] as const;

/** Union of the predicate names M30 registers. */
export type M30RegisteredAbacPredicate = (typeof M30_REGISTERED_ABAC_PREDICATES)[number];

// -----------------------------------------------------------------------------
// Canonical M3 role keys the §6.7 predicates match against (the role catalog keys, not display
// names). `qapi_coordinator` is the Appendix-A `system_default` template; the rest are the
// `system_locked` floor roles. Matching is by string — an unknown key simply fails closed (deny).
// -----------------------------------------------------------------------------
const ROLE_MEDICAL_DIRECTOR = "medical_director";
const ROLE_ADMINISTRATOR = "administrator";
const ROLE_COMPLIANCE_OFFICER = "compliance_officer";
const ROLE_SECURITY_OFFICER = "hipaa_security_officer";
const ROLE_QAPI_COORDINATOR = "qapi_coordinator";

/** The D23 retention class promoting a row into 42 CFR Part 2 protection (the `part2Redisclosure` gate). */
const RETENTION_CLASS_PART2 = "compliance_42cfr_part2";

// -----------------------------------------------------------------------------
// Owner facts the predicates resolve (in-memory in unit tests; Drizzle under RLS in prod). Each load
// is org-scoped; a `null` return is an absent / cross-tenant row → fail-closed.
// -----------------------------------------------------------------------------

/** Owner/visibility facts for an `incident_report` row (§4.7 incident predicates). */
export interface IncidentAbacFacts {
  readonly incidentId: string;
  readonly organizationId: string;
  /** The incident kind; `allegation_of_abuse` is the visibility-gated kind. */
  readonly kind: string;
  /** The reporter's user id (the draft author). */
  readonly reportedByUserId: string;
  /** The assigned investigator's user id (set at triage; null before). */
  readonly assignedToUserId: string | null;
}

/** Owner facts for a `qapi_project` row (§4.7 `ownsQapiProject`). */
export interface QapiProjectAbacFacts {
  readonly projectId: string;
  readonly organizationId: string;
  /** The project lead's user id (`led_by_user_id`). */
  readonly ledByUserId: string;
}

/** Owner facts for an `sra_cycle` row (§4.7 `ownsSraCycle`). */
export interface SraCycleAbacFacts {
  readonly cycleId: string;
  readonly organizationId: string;
  /** The cycle owner's user id (`owner_user_id`). */
  readonly ownerUserId: string;
}

/** Owner facts for a `mortality_review` row (§4.7 `assignedToMortality`). */
export interface MortalityReviewAbacFacts {
  readonly reviewId: string;
  readonly organizationId: string;
  /** The assigned reviewer's user id (null before assignment). */
  readonly assignedToUserId: string | null;
}

/**
 * Loads the org-scoped owner facts + the OPAQUE M5/M39 Part-2 reach the M30 predicates resolve
 * (in-memory in unit tests; Drizzle under RLS in prod, P2C). The M5 PrivacyFlag snapshot + M39 consent
 * reach is opaque (no `@wardenx/patient` / M39 import edge) — the deny-stub returns false (fail-closed).
 */
export interface ReadingM30AbacResolver {
  /** Load an incident's owner/visibility facts; `null` for an absent / cross-tenant row → deny. */
  loadIncident(organizationId: string, incidentId: string): Promise<IncidentAbacFacts | null>;
  /** Load a QAPI project's owner facts; `null` → deny. */
  loadQapiProject(organizationId: string, projectId: string): Promise<QapiProjectAbacFacts | null>;
  /** Load an SRA cycle's owner facts; `null` → deny. */
  loadSraCycle(organizationId: string, cycleId: string): Promise<SraCycleAbacFacts | null>;
  /** Load a mortality review's owner facts; `null` → deny. */
  loadMortalityReview(
    organizationId: string,
    reviewId: string,
  ): Promise<MortalityReviewAbacFacts | null>;
  /** The role keys an org member holds — drives the two-actor co-signer role resolution. */
  loadMemberRoleKeys(input: {
    organizationId: string;
    userId: string;
  }): Promise<readonly string[]>;
  /** M5 PrivacyFlag snapshot (opaque): does the patient carry a 42 CFR Part 2 protection? */
  isPatientPart2Protected(input: {
    organizationId: string;
    patientId: string;
  }): Promise<boolean>;
  /** M39 consent (opaque): a valid unexpired `42_cfr_part_2_release` covering this actor→patient access? */
  hasPart2ReleaseCoveringActor(input: {
    organizationId: string;
    patientId: string;
    userId: string;
  }): Promise<boolean>;
}

/** Deps for M30's ABAC predicate resolvers (the slice/boot injects an in-memory or deny-stub resolver). */
export interface ReadingM30AbacDeps {
  /** Loads org-scoped owner facts + the opaque M5/M39 Part-2 reach (deny-stub-safe until P2C binds them). */
  readonly resolver: ReadingM30AbacResolver;
}

/**
 * Deny-stub `ReadingM30AbacResolver` — every lookup fails closed (no row, no roles, not protected, no
 * release). Lets the composition root register the predicates at boot BEFORE the real Drizzle + M5/M39
 * seam binding lands (P2C): with this resolver every owner/role/visibility predicate denies and
 * `part2Redisclosure` redacts every Part-2-promoted row (no covering release resolvable). Never fails open.
 */
export const denyStubM30AbacResolver: ReadingM30AbacResolver = {
  async loadIncident() {
    return null;
  },
  async loadQapiProject() {
    return null;
  },
  async loadSraCycle() {
    return null;
  },
  async loadMortalityReview() {
    return null;
  },
  async loadMemberRoleKeys() {
    return [];
  },
  async isPatientPart2Protected() {
    return false;
  },
  async hasPart2ReleaseCoveringActor() {
    return false;
  },
};

// ---- shared helpers ---------------------------------------------------------
const hasRole = (context: AbacContext, role: string): boolean => context.roles.includes(role);

const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/**
 * Read whether the actor holds a permission grant, from the SERVER-assembled `context.attributes.
 * permissions` list (the route layer binds the resolved grant set; never client input). Absent → false
 * (fail-closed). Used by the owner-OR-admin predicates (`ownsQapiProject`/`ownsSraCycle`) and
 * `abuseAllegationAccess`'s explicit-grant arm.
 */
function actorHoldsPermission(context: AbacContext, key: string): boolean {
  const granted = context.attributes.permissions;
  return Array.isArray(granted) && granted.includes(key);
}

/**
 * Build M30's eleven §4.7 predicate resolvers over injected deps (pure factory — unit-tested with a
 * fresh registry; the boot path registers these via {@link registerM30AbacPredicates}). Target ids come
 * from the route `:id`/payload; a missing / cross-tenant fact row fails closed (deny). Every predicate
 * also re-checks `target.organizationId`-free since the resolver loads are already org-scoped to
 * `context.organizationId`.
 */
export function buildM30AbacPredicates(
  deps: ReadingM30AbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  const org = (context: AbacContext): string => context.organizationId;

  return {
    // (a) `incident.read` AND kind ≠ allegation_of_abuse, OR (b) `incident.abuse_review` AND kind =
    // allegation_of_abuse, OR (c) actor ∈ {reportedBy ∪ assignedTo}. §4.7.
    incidentVisibility: async (context, target) => {
      const incidentId = targetStr(target, "incidentId");
      if (!incidentId) return false; // fail-closed
      const incident = await resolver.loadIncident(org(context), incidentId);
      if (!incident) return false; // absent / cross-tenant
      const isAbuse = incident.kind === "allegation_of_abuse";
      if (!isAbuse && actorHoldsPermission(context, "incident.read")) return true; // (a)
      if (isAbuse && actorHoldsPermission(context, "incident.abuse_review")) return true; // (b)
      // (c) actor is the reporter or the assignee.
      if (context.userId === incident.reportedByUserId) return true;
      if (incident.assignedToUserId && context.userId === incident.assignedToUserId) return true;
      return false;
    },

    // `actor.id ∈ {incident.reportedByUserId, incident.assignedToUserId}`. §4.7.
    ownsIncident: async (context, target) => {
      const incidentId = targetStr(target, "incidentId");
      if (!incidentId) return false;
      const incident = await resolver.loadIncident(org(context), incidentId);
      if (!incident) return false;
      if (context.userId === incident.reportedByUserId) return true;
      return Boolean(incident.assignedToUserId) && context.userId === incident.assignedToUserId;
    },

    // `actor.id === incident.assignedToUserId`. §4.7.
    assignedToIncident: async (context, target) => {
      const incidentId = targetStr(target, "incidentId");
      if (!incidentId) return false;
      const incident = await resolver.loadIncident(org(context), incidentId);
      if (!incident) return false;
      return Boolean(incident.assignedToUserId) && context.userId === incident.assignedToUserId;
    },

    // role Compliance Officer OR Administrator OR explicit `incident.abuse_review` grant. §4.7. The only
    // path the `allegation_of_abuse` kind reaches a user's queue (R-61).
    abuseAllegationAccess: async (context) => {
      if (hasRole(context, ROLE_COMPLIANCE_OFFICER)) return true;
      if (hasRole(context, ROLE_ADMINISTRATOR)) return true;
      return actorHoldsPermission(context, "incident.abuse_review");
    },

    // role QAPI Coordinator OR Compliance Officer AND `actor.id ≠ incident.assignedToUserId`
    // (separation-of-duties; M30-F03 / ADR-0022 — the resolver/closer cannot be the assignee). §4.7.
    capVerifyAuthority: async (context, target) => {
      const incidentId = targetStr(target, "incidentId");
      if (!incidentId) return false;
      const incident = await resolver.loadIncident(org(context), incidentId);
      if (!incident) return false; // fail-closed
      const hasAuthorityRole =
        hasRole(context, ROLE_QAPI_COORDINATOR) || hasRole(context, ROLE_COMPLIANCE_OFFICER);
      if (!hasAuthorityRole) return false;
      // The verifier MUST NOT be the incident's assignee (the two-person control). An unassigned
      // incident cannot be verified (no assignee to separate from) → deny.
      if (!incident.assignedToUserId) return false;
      return context.userId !== incident.assignedToUserId;
    },

    // `actor.id === qapi_project.led_by_user_id` OR actor holds `qapi.admin`. §4.7.
    ownsQapiProject: async (context, target) => {
      const projectId = targetStr(target, "projectId");
      if (!projectId) return false;
      const project = await resolver.loadQapiProject(org(context), projectId);
      if (!project) return false;
      if (context.userId === project.ledByUserId) return true;
      return actorHoldsPermission(context, "qapi.admin");
    },

    // Two-actor: caller ∈ {QAPI Coordinator, Medical Director} AND the second co-signer holds the OTHER
    // role, and the two actors are distinct (D12 / V-11). The cosigner's roles are resolved server-side.
    qapiCloseAuthority: async (context, target) => {
      const cosignerUserId = targetStr(target, "cosignerUserId");
      if (!cosignerUserId) return false; // fail-closed (no second signer)
      if (cosignerUserId === context.userId) return false; // must be two distinct actors
      const callerIsQc = hasRole(context, ROLE_QAPI_COORDINATOR);
      const callerIsMd = hasRole(context, ROLE_MEDICAL_DIRECTOR);
      if (!callerIsQc && !callerIsMd) return false;
      const cosignerRoles = await resolver.loadMemberRoleKeys({
        organizationId: org(context),
        userId: cosignerUserId,
      });
      const cosignerIsQc = cosignerRoles.includes(ROLE_QAPI_COORDINATOR);
      const cosignerIsMd = cosignerRoles.includes(ROLE_MEDICAL_DIRECTOR);
      // caller and cosigner must occupy the TWO different roles {QC, MD}.
      return (callerIsQc && cosignerIsMd) || (callerIsMd && cosignerIsQc);
    },

    // `actor.id === sra_cycle.owner_user_id` OR actor holds `sra.admin`. §4.7.
    ownsSraCycle: async (context, target) => {
      const cycleId = targetStr(target, "cycleId");
      if (!cycleId) return false;
      const cycle = await resolver.loadSraCycle(org(context), cycleId);
      if (!cycle) return false;
      if (context.userId === cycle.ownerUserId) return true;
      return actorHoldsPermission(context, "sra.admin");
    },

    // Two-actor: caller Security Officer + second co-signer Compliance Officer (or vice versa), distinct
    // actors (D12 / V-12). §4.7.
    sraCloseAuthority: async (context, target) => {
      const cosignerUserId = targetStr(target, "cosignerUserId");
      if (!cosignerUserId) return false;
      if (cosignerUserId === context.userId) return false; // two distinct actors
      const callerIsSo = hasRole(context, ROLE_SECURITY_OFFICER);
      const callerIsCo = hasRole(context, ROLE_COMPLIANCE_OFFICER);
      if (!callerIsSo && !callerIsCo) return false;
      const cosignerRoles = await resolver.loadMemberRoleKeys({
        organizationId: org(context),
        userId: cosignerUserId,
      });
      const cosignerIsSo = cosignerRoles.includes(ROLE_SECURITY_OFFICER);
      const cosignerIsCo = cosignerRoles.includes(ROLE_COMPLIANCE_OFFICER);
      return (callerIsSo && cosignerIsCo) || (callerIsCo && cosignerIsSo);
    },

    // `actor.id === mortality_review.assigned_to_user_id`. §4.7.
    assignedToMortality: async (context, target) => {
      const reviewId = targetStr(target, "reviewId");
      if (!reviewId) return false;
      const review = await resolver.loadMortalityReview(org(context), reviewId);
      if (!review) return false;
      return Boolean(review.assignedToUserId) && context.userId === review.assignedToUserId;
    },

    // (M30-F14, ADR-0014 / SEC-046) The per-row redaction filter for Part-2-promoted rows. A row whose
    // `retention_class ≠ compliance_42cfr_part2` passes unconditionally; a Part-2-promoted row passes
    // iff the linked patient carries an M5 Part 2 PrivacyFlag AND a valid unexpired M39
    // `42_cfr_part_2_release` covers the actor's access. Default-deny / fail-closed: missing
    // retention_class, missing patient link, unreachable M5/M39 reach, or no covering release ⇒ false
    // (row redacted). §6.7.
    part2Redisclosure: async (context, target) => {
      const retentionClass = targetStr(target, "retentionClass");
      if (!retentionClass) return false; // route must supply the row's retention class → fail-closed
      if (retentionClass !== RETENTION_CLASS_PART2) return true; // not Part-2-promoted → pass
      const patientId = targetStr(target, "patientId");
      if (!patientId) return false; // Part-2 row with no resolvable patient link → redact
      const protectedFlag = await resolver.isPatientPart2Protected({
        organizationId: org(context),
        patientId,
      });
      if (!protectedFlag) return false; // snapshot absent / unreachable → redact
      return resolver.hasPart2ReleaseCoveringActor({
        organizationId: org(context),
        patientId,
        userId: context.userId,
      });
    },
  };
}

/**
 * Register M30's eleven §4.7 ABAC predicate resolvers into M3's shared registry (idempotent). Call at
 * boot; defaults to the {@link denyStubM30AbacResolver} so the predicates EXIST (fail-closed) BEFORE the
 * real Drizzle + M5 PrivacyFlag / M39 consent binding lands (P2C). Re-boot (tests) skips already-
 * registered names (single-owner / no-clear; the M33 / M34 precedent).
 */
export function registerM30AbacPredicates(
  deps: ReadingM30AbacDeps = { resolver: denyStubM30AbacResolver },
): void {
  const predicates = buildM30AbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    if (abacRegistry.has(name)) continue;
    registerPredicate(name, predicate);
  }
}
