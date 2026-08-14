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
// P2c — the REAL Drizzle fact-loader. `buildDrizzleM30AbacResolver(db)` loads each owner fact under
// `withOrgContext` (RLS scopes every read to `app.org_id`), mirroring the M34 §4.6 resolver shape (the
// composition root binds the db handle; the M33/M34 SLICE_*_ABAC_RESOLVER precedent).
//
// GAP-047 — the two Part-2 reaches are REAL NOW. They were fail-closed deny-stubs because the seams
// they need did not exist: M5's PrivacyFlag snapshot landed later as `PatientPrivacyFlagReader`
// (GAP-061, for M37's shared-room gate) and M39's `ConsentEvaluator` is registered at boot over the
// Drizzle consent store. So `part2Redisclosure` no longer redacts EVERY Part-2-promoted row
// unconditionally — a patient carrying M5's `sud` privacy flag with an active `42_cfr_part_2_release`
// on file now passes. `abuseAllegationAccess` keeps its role-only default (the clearance/case-access
// read it would key on is genuinely not landed). Default-deny throughout: a missing / cross-tenant
// fact row, an actor with no active membership, an unreachable M5/M39 seam all resolve to deny.
// Never fails open.
//
// IDENTITY NOTE (the P2c correctness fix): the §3 owner columns are MEMBERSHIP ids
// (`reported_by_membership_id`, `owner_membership_id`, `opened_by_membership_id`,
// `assigned_reviewer_membership_id`) — never user ids. The §4.7 ownership predicates therefore key on the
// actor's ACTIVE membership id (`context.attributes.membershipId`, the server-assembled M2 session
// attribute the routes' `writeActorOf` already trusts), NOT `context.userId` (which lives in a different
// id space). An actor whose session carries no membership id cannot own an M30 row → deny.
//
// NB §6.7's `part2Redisclosure` was OMITTED from the pure `@wardenx/quality` `M30_ABAC_PREDICATES`
// name catalog (which lists `inOrg` + the ten operator predicates). It is added HERE so the predicate
// EXISTS (fail-closed) at boot; the pure const may want `part2Redisclosure` appended for surface
// self-description, but this slice does NOT edit packages/quality.
//
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests) guards
// on `abacRegistry.has` (the M33 `registerM33AbacPredicates` / M34 precedent). Never fails open.
import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@wardenx/auth";
import { schema } from "@wardenx/db";
import type { QualityDb } from "@wardenx/quality";
import { withOrgContext } from "@wardenx/tenancy";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { getSeam } from "../../bootstrap/index";

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

/** The M5 §3.5 privacy flag that puts a patient's records under 42 CFR Part 2 (GAP-047). */
const PART2_FLAG = "sud";

/** The minimal M39 surface this file calls — structurally typed so M30 takes no `@wardenx/consent`
 *  import edge (the M9 `capture-siting.ts` / M7 `seams/drizzle-store.ts` precedent). */
interface M30ConsentEvaluatorShape {
  evaluateForInternalAccess(args: {
    organizationId: string;
    patientId: string;
    actor: { membershipId: string | null };
    callerModule: string;
  }): Promise<{ redactSubstanceUseDisorderFields: boolean }>;
}

/** The incident kind whose disclosure is visibility-gated (R-61). */
const INCIDENT_KIND_ABUSE = "allegation_of_abuse";

// -----------------------------------------------------------------------------
// Owner facts the predicates resolve (Drizzle under RLS in prod via the P2c resolver; an in-memory
// resolver in unit tests). Each load is org-scoped; a `null` return is an absent / cross-tenant row →
// fail-closed. Every `*MembershipId` is an M2 membership id — the actor's own membership id (the server-
// assembled `context.attributes.membershipId`) is what these predicates compare against.
// -----------------------------------------------------------------------------

/** The org + acting user the resolver scopes each load to (the `withOrgContext` GUCs), plus the
 *  actor's ACTIVE membership id — the id space `consent_record_recipient` names a `workforce_member`
 *  with, and therefore what M39's per-actor Part 2 verdict is keyed on. `null` when the session
 *  carries no membership; against a workforce-restricted release that resolves to redact. */
export interface M30AbacReadContext {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string | null;
}

/** Owner/visibility facts for an `incident_report` row (§4.7 incident predicates). */
export interface IncidentAbacFacts {
  readonly incidentId: string;
  readonly organizationId: string;
  /** The incident kind; `allegation_of_abuse` is the visibility-gated kind. */
  readonly kind: string;
  /** The reporter's membership id (`reported_by_membership_id`, the draft author). */
  readonly reportedByMembershipId: string;
  /** The assigned investigator's membership id (`triaged_by_membership_id`; null before triage). */
  readonly assignedToMembershipId: string | null;
}

/** Owner facts for a `qapi_project` row (§4.7 `ownsQapiProject`). */
export interface QapiProjectAbacFacts {
  readonly projectId: string;
  readonly organizationId: string;
  /** The project lead's membership id (`owner_membership_id`). */
  readonly ownerMembershipId: string;
}

/** Owner facts for an `sra_cycle` row (§4.7 `ownsSraCycle`). */
export interface SraCycleAbacFacts {
  readonly cycleId: string;
  readonly organizationId: string;
  /** The cycle owner's membership id (`opened_by_membership_id`). */
  readonly ownerMembershipId: string;
}

/** Owner facts for a `mortality_review` row (§4.7 `assignedToMortality`). */
export interface MortalityReviewAbacFacts {
  readonly reviewId: string;
  readonly organizationId: string;
  /** The assigned reviewer's membership id (`assigned_reviewer_membership_id`; null before assignment). */
  readonly assignedToMembershipId: string | null;
}

/**
 * Loads the org-scoped owner facts + the OPAQUE M5/M39 Part-2 reach the M30 predicates resolve (Drizzle
 * under RLS in prod via {@link buildDrizzleM30AbacResolver}; an in-memory stub in unit tests). The M5
 * PrivacyFlag snapshot + M39 consent reach is opaque (no `@wardenx/patient` / M39 import edge) — the
 * Drizzle resolver returns false (fail-closed) until those seams land in the M1 SeamContracts.
 */
export interface ReadingM30AbacResolver {
  /** Load an incident's owner/visibility facts; `null` for an absent / cross-tenant row → deny. */
  loadIncident(ctx: M30AbacReadContext, incidentId: string): Promise<IncidentAbacFacts | null>;
  /** Load a QAPI project's owner facts; `null` → deny. */
  loadQapiProject(ctx: M30AbacReadContext, projectId: string): Promise<QapiProjectAbacFacts | null>;
  /** Load an SRA cycle's owner facts; `null` → deny. */
  loadSraCycle(ctx: M30AbacReadContext, cycleId: string): Promise<SraCycleAbacFacts | null>;
  /** Load a mortality review's owner facts; `null` → deny. */
  loadMortalityReview(
    ctx: M30AbacReadContext,
    reviewId: string,
  ): Promise<MortalityReviewAbacFacts | null>;
  /** The (live, unexpired) role keys an org member holds — drives the two-actor co-signer resolution. */
  loadMemberRoleKeys(ctx: M30AbacReadContext, membershipId: string): Promise<readonly string[]>;
  /** M5 PrivacyFlag snapshot (opaque): does the patient carry a 42 CFR Part 2 protection? */
  isPatientPart2Protected(ctx: M30AbacReadContext, patientId: string): Promise<boolean>;
  /**
   * M39 consent (opaque): does an ACTIVE, unexpired `42_cfr_part_2_release` cover THIS actor's access
   * to this patient's Part-2 material right now?
   *
   * The name has been round-tripped, and the history is the point. It shipped as
   * `hasPart2ReleaseCoveringActor`, a deny-stub. GAP-047 made it real and renamed it
   * `hasActivePart2Release`, because the per-actor promise was unbuildable: M39's per-recipient
   * evaluation keys on an EXTERNAL recipient (a resolved recipient id or a FHIR client id), and an
   * internal staff actor reading a quality row is not a recipient in that sense — so the honest
   * answer was the org-wide one, "is disclosure of this patient's Part-2 material authorized here at
   * all". `workforce_member` recipients (mig 0209) + `evaluateForInternalAccess` closed that gap, so
   * the per-actor question is now answerable and the name says so again.
   *
   * WHICH staff may read the row is still ALSO the job of the RBAC permission and the other §4.7
   * predicates the same routes compose — this narrows, it does not replace them.
   */
  part2ReleaseCoversActor(ctx: M30AbacReadContext, patientId: string): Promise<boolean>;
}

/**
 * Deps for M30's ABAC predicate resolvers. The boot path passes a Drizzle `db` handle (the resolver reads
 * owner facts under RLS); unit tests may inject an in-memory `resolver` directly. Precedence: an explicit
 * `resolver` wins, else `db` builds the real Drizzle resolver, else the {@link denyStubM30AbacResolver}.
 */
export interface ReadingM30AbacDeps {
  /** The Drizzle handle the real resolver opens `withOrgContext` over (the composition root binds it). */
  readonly db?: QualityDb;
  /** An explicit resolver (in-memory in unit tests); overrides `db` when present. */
  readonly resolver?: ReadingM30AbacResolver;
}

/**
 * Deny-stub `ReadingM30AbacResolver` — every lookup fails closed (no row, no roles, not protected, no
 * release). Lets the composition root register the predicates at boot BEFORE a db handle is bound: with
 * this resolver every owner/role/visibility predicate denies and `part2Redisclosure` redacts every
 * Part-2-promoted row (no covering release resolvable). Never fails open.
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
  async part2ReleaseCoversActor() {
    return false;
  },
};

/**
 * The REAL P2c Drizzle-backed `ReadingM30AbacResolver`. Each owner-fact load opens ONE
 * `withOrgContext(db, {organizationId, userId}, tx => …)` (the M1 @wardenx/tenancy helper) so Postgres RLS
 * scopes every statement to `app.org_id` — the read-service-drizzle precedent. The partitioned tables
 * (`incident_report`, `mortality_review`) are point-read by id alone (org + RLS scope the row; the
 * partition key need not be supplied for a single-row lookup). `loadMemberRoleKeys` joins
 * `membership_role` → `role` for the LIVE (unexpired) role keys.
 *
 * The two M5/M39 Part-2 reaches go through the M1 seam registry (GAP-047), not through a schema edge:
 * `PatientPrivacyFlagReader` is leaf-typed in @wardenx/types so `getSeam` resolves it with no import
 * edge, and M39's `ConsentEvaluator` is opaque in the registry so it is narrowed here by a local
 * structural shape (the M9 `capture-siting.ts` precedent). Both fail closed on a seam error.
 */
export function buildDrizzleM30AbacResolver(db: QualityDb): ReadingM30AbacResolver {
  const I = schema.incidentReport;
  const PRJ = schema.qapiProject;
  const CY = schema.sraCycle;
  const MR = schema.mortalityReview;
  const ROLE = schema.roles;
  const MEMBER_ROLE = schema.membershipRoles;

  return {
    async loadIncident(ctx, incidentId) {
      return withOrgContext(db, ctx, async (tx) => {
        const [row] = await tx
          .select({
            id: I.id,
            organizationId: I.organizationId,
            kind: I.kind,
            reportedByMembershipId: I.reportedByMembershipId,
            triagedByMembershipId: I.triagedByMembershipId,
          })
          .from(I)
          .where(and(eq(I.organizationId, ctx.organizationId), eq(I.id, incidentId)))
          .limit(1);
        if (!row) return null;
        return {
          incidentId: row.id,
          organizationId: row.organizationId,
          kind: row.kind,
          reportedByMembershipId: row.reportedByMembershipId,
          assignedToMembershipId: row.triagedByMembershipId ?? null,
        };
      });
    },

    async loadQapiProject(ctx, projectId) {
      return withOrgContext(db, ctx, async (tx) => {
        const [row] = await tx
          .select({
            id: PRJ.id,
            organizationId: PRJ.organizationId,
            ownerMembershipId: PRJ.ownerMembershipId,
          })
          .from(PRJ)
          .where(and(eq(PRJ.organizationId, ctx.organizationId), eq(PRJ.id, projectId)))
          .limit(1);
        if (!row) return null;
        return {
          projectId: row.id,
          organizationId: row.organizationId,
          ownerMembershipId: row.ownerMembershipId,
        };
      });
    },

    async loadSraCycle(ctx, cycleId) {
      return withOrgContext(db, ctx, async (tx) => {
        const [row] = await tx
          .select({
            id: CY.id,
            organizationId: CY.organizationId,
            openedByMembershipId: CY.openedByMembershipId,
          })
          .from(CY)
          .where(and(eq(CY.organizationId, ctx.organizationId), eq(CY.id, cycleId)))
          .limit(1);
        if (!row) return null;
        return {
          cycleId: row.id,
          organizationId: row.organizationId,
          ownerMembershipId: row.openedByMembershipId,
        };
      });
    },

    async loadMortalityReview(ctx, reviewId) {
      return withOrgContext(db, ctx, async (tx) => {
        const [row] = await tx
          .select({
            id: MR.id,
            organizationId: MR.organizationId,
            assignedReviewerMembershipId: MR.assignedReviewerMembershipId,
          })
          .from(MR)
          .where(and(eq(MR.organizationId, ctx.organizationId), eq(MR.id, reviewId)))
          .limit(1);
        if (!row) return null;
        return {
          reviewId: row.id,
          organizationId: row.organizationId,
          assignedToMembershipId: row.assignedReviewerMembershipId ?? null,
        };
      });
    },

    async loadMemberRoleKeys(ctx, membershipId) {
      return withOrgContext(db, ctx, async (tx) => {
        const rows = await tx
          .select({ key: ROLE.key })
          .from(MEMBER_ROLE)
          .innerJoin(ROLE, eq(MEMBER_ROLE.roleId, ROLE.id))
          .where(
            and(
              eq(MEMBER_ROLE.organizationId, ctx.organizationId),
              eq(MEMBER_ROLE.membershipId, membershipId),
              // time-bound roles (on-call elevation, §7.2): only the live, unexpired grants count.
              or(isNull(MEMBER_ROLE.expiresAt), gt(MEMBER_ROLE.expiresAt, new Date())),
            ),
          );
        return rows.map((r) => r.key);
      });
    },

    /**
     * GAP-047 — M5's §3.5 privacy-flag snapshot, through the published `PatientPrivacyFlagReader`
     * seam. This was a fail-closed deny-stub because that seam did not exist when M30 landed; GAP-061
     * built it for M37's shared-room gate, and its `privacyFlags` field is the general §3.5 fact, not
     * a rooming-specific one (the method simply carries its first consumer's name).
     *
     * `sud` is the flag that promotes a patient's records into 42 CFR Part 2 protection. An absent
     * snapshot row yields an empty flag array — "no flag recorded" — which correctly reads as
     * not-Part-2-protected rather than as unreadable.
     */
    async isPatientPart2Protected(ctx, patientId) {
      try {
        const facts = await getSeam("PatientPrivacyFlagReader").roomingFactsFor({
          organizationId: ctx.organizationId,
          patientIds: [patientId],
        });
        return facts.some((f) => f.patientId === patientId && f.privacyFlags.includes(PART2_FLAG));
      } catch {
        return false; // seam unregistered / deny-stub / unreachable → not provably protected
      }
    },

    /**
     * M39's `42_cfr_part_2_release`, through the `ConsentEvaluator` seam's PER-ACTOR evaluation:
     * `redactSubstanceUseDisorderFields` is false exactly when the governing release covers this
     * actor — which, for a release naming no workforce members, is every actor in the treating
     * program (42 CFR §2.12(c)(3)), and for one that names them, only those named.
     *
     * GAP-047 first wired this to `evaluateForIngressRedaction`, the PATIENT-scope primitive, because
     * that was the only question M39 could answer about an internal caller. M7's `sud_disclosure_allowed`
     * and M15's disclosure gate now resolve the same `evaluateForInternalAccess` primitive, so the
     * three cannot disagree about whether a given clinician may see a given patient's Part-2 material.
     *
     * Fail-CLOSED on any seam error: `part2Redisclosure` then redacts the row, which is where this
     * predicate has been for its whole life — the difference is that it can now also open.
     */
    async part2ReleaseCoversActor(ctx, patientId) {
      try {
        const evaluator = getSeam("ConsentEvaluator") as unknown as M30ConsentEvaluatorShape;
        const res = await evaluator.evaluateForInternalAccess({
          organizationId: ctx.organizationId,
          patientId,
          actor: { membershipId: ctx.membershipId },
          callerModule: "m30",
        });
        return !res.redactSubstanceUseDisorderFields;
      } catch {
        return false;
      }
    },
  };
}

// ---- shared helpers ---------------------------------------------------------
const hasRole = (context: AbacContext, role: string): boolean => context.roles.includes(role);

const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/**
 * The actor's ACTIVE membership id — the server-assembled M2 session attribute the routes' `writeActorOf`
 * already trusts (`context.attributes.membershipId`). The §4.7 ownership predicates key on THIS, never on
 * `context.userId` (a different id space than the §3 `*_membership_id` owner columns). Absent → null
 * (fail-closed: an actor with no active membership cannot own an M30 row).
 */
function actorMembershipId(context: AbacContext): string | null {
  const value = context.attributes.membershipId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The org + acting user the resolver scopes its `withOrgContext` reads to. */
function readContextOf(context: AbacContext): M30AbacReadContext {
  return {
    organizationId: context.organizationId,
    userId: context.userId,
    membershipId: actorMembershipId(context),
  };
}

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
 * Resolve the injected/derived resolver for a predicate factory: an explicit `resolver` wins (tests), else
 * a `db` handle builds the real Drizzle resolver, else the fail-closed deny-stub.
 */
function resolverFor(deps: ReadingM30AbacDeps): ReadingM30AbacResolver {
  if (deps.resolver) return deps.resolver;
  if (deps.db) return buildDrizzleM30AbacResolver(deps.db);
  return denyStubM30AbacResolver;
}

/**
 * Build M30's eleven §4.7 predicate resolvers over a Drizzle `db` handle (or an injected `resolver` for
 * unit tests). Target ids come from the route `:id`/payload; a missing / cross-tenant fact row, or an
 * actor with no active membership, fails closed (deny). Every resolver load is already org-scoped to
 * `context.organizationId` under RLS.
 */
export function buildM30AbacPredicates(
  deps: ReadingM30AbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const resolver = resolverFor(deps);

  return {
    // (a) `incident.read` AND kind ≠ allegation_of_abuse, OR (b) `incident.abuse_review` AND kind =
    // allegation_of_abuse, OR (c) actor membership ∈ {reportedBy ∪ assignedTo}. §4.7.
    incidentVisibility: async (context, target) => {
      const incidentId = targetStr(target, "incidentId");
      if (!incidentId) return false; // fail-closed
      const incident = await resolver.loadIncident(readContextOf(context), incidentId);
      if (!incident) return false; // absent / cross-tenant
      const isAbuse = incident.kind === INCIDENT_KIND_ABUSE;
      if (!isAbuse && actorHoldsPermission(context, "incident.read")) return true; // (a)
      if (isAbuse && actorHoldsPermission(context, "incident.abuse_review")) return true; // (b)
      // (c) actor is the reporter or the assignee.
      const membershipId = actorMembershipId(context);
      if (!membershipId) return false;
      if (membershipId === incident.reportedByMembershipId) return true;
      return incident.assignedToMembershipId === membershipId;
    },

    // `actor.membership ∈ {incident.reportedByMembershipId, incident.assignedToMembershipId}`. §4.7.
    ownsIncident: async (context, target) => {
      const incidentId = targetStr(target, "incidentId");
      if (!incidentId) return false;
      const incident = await resolver.loadIncident(readContextOf(context), incidentId);
      if (!incident) return false;
      const membershipId = actorMembershipId(context);
      if (!membershipId) return false;
      if (membershipId === incident.reportedByMembershipId) return true;
      return incident.assignedToMembershipId === membershipId;
    },

    // `actor.membership === incident.assignedToMembershipId`. §4.7.
    assignedToIncident: async (context, target) => {
      const incidentId = targetStr(target, "incidentId");
      if (!incidentId) return false;
      const incident = await resolver.loadIncident(readContextOf(context), incidentId);
      if (!incident) return false;
      const membershipId = actorMembershipId(context);
      if (!membershipId) return false;
      return incident.assignedToMembershipId === membershipId;
    },

    // role Compliance Officer OR Administrator OR explicit `incident.abuse_review` grant. §4.7. The only
    // path the `allegation_of_abuse` kind reaches a user's queue (R-61). Role-only by design — the
    // clearance/case-access read a finer control would key on is not landed (kept fail-closed: deny
    // unless one of the named roles/grant is held).
    abuseAllegationAccess: async (context) => {
      if (hasRole(context, ROLE_COMPLIANCE_OFFICER)) return true;
      if (hasRole(context, ROLE_ADMINISTRATOR)) return true;
      return actorHoldsPermission(context, "incident.abuse_review");
    },

    // role QAPI Coordinator OR Compliance Officer AND `actor.membership ≠ incident.assignedToMembershipId`
    // (separation-of-duties; M30-F03 / ADR-0022 — the resolver/closer cannot be the assignee). §4.7.
    capVerifyAuthority: async (context, target) => {
      const incidentId = targetStr(target, "incidentId");
      if (!incidentId) return false;
      const incident = await resolver.loadIncident(readContextOf(context), incidentId);
      if (!incident) return false; // fail-closed
      const hasAuthorityRole =
        hasRole(context, ROLE_QAPI_COORDINATOR) || hasRole(context, ROLE_COMPLIANCE_OFFICER);
      if (!hasAuthorityRole) return false;
      // The verifier MUST NOT be the incident's assignee (the two-person control). An unassigned
      // incident cannot be verified (no assignee to separate from) → deny.
      if (!incident.assignedToMembershipId) return false;
      const membershipId = actorMembershipId(context);
      if (!membershipId) return false;
      return membershipId !== incident.assignedToMembershipId;
    },

    // `actor.membership === qapi_project.owner_membership_id` OR actor holds `qapi.admin`. §4.7.
    ownsQapiProject: async (context, target) => {
      const projectId = targetStr(target, "projectId");
      if (!projectId) return false;
      const project = await resolver.loadQapiProject(readContextOf(context), projectId);
      if (!project) return false;
      const membershipId = actorMembershipId(context);
      if (membershipId && membershipId === project.ownerMembershipId) return true;
      return actorHoldsPermission(context, "qapi.admin");
    },

    // Two-actor: caller ∈ {QAPI Coordinator, Medical Director} AND the second co-signer holds the OTHER
    // role, and the two actors are distinct (D12 / V-11). The cosigner's roles are resolved server-side.
    qapiCloseAuthority: async (context, target) => {
      const cosignerMembershipId = targetStr(target, "cosignerMembershipId");
      if (!cosignerMembershipId) return false; // fail-closed (no second signer)
      const callerMembershipId = actorMembershipId(context);
      if (!callerMembershipId) return false;
      if (cosignerMembershipId === callerMembershipId) return false; // must be two distinct actors
      const callerIsQc = hasRole(context, ROLE_QAPI_COORDINATOR);
      const callerIsMd = hasRole(context, ROLE_MEDICAL_DIRECTOR);
      if (!callerIsQc && !callerIsMd) return false;
      const cosignerRoles = await resolver.loadMemberRoleKeys(
        readContextOf(context),
        cosignerMembershipId,
      );
      const cosignerIsQc = cosignerRoles.includes(ROLE_QAPI_COORDINATOR);
      const cosignerIsMd = cosignerRoles.includes(ROLE_MEDICAL_DIRECTOR);
      // caller and cosigner must occupy the TWO different roles {QC, MD}.
      return (callerIsQc && cosignerIsMd) || (callerIsMd && cosignerIsQc);
    },

    // `actor.membership === sra_cycle.owner_membership_id` OR actor holds `sra.admin`. §4.7.
    ownsSraCycle: async (context, target) => {
      const cycleId = targetStr(target, "cycleId");
      if (!cycleId) return false;
      const cycle = await resolver.loadSraCycle(readContextOf(context), cycleId);
      if (!cycle) return false;
      const membershipId = actorMembershipId(context);
      if (membershipId && membershipId === cycle.ownerMembershipId) return true;
      return actorHoldsPermission(context, "sra.admin");
    },

    // Two-actor: caller Security Officer + second co-signer Compliance Officer (or vice versa), distinct
    // actors (D12 / V-12). §4.7.
    sraCloseAuthority: async (context, target) => {
      const cosignerMembershipId = targetStr(target, "cosignerMembershipId");
      if (!cosignerMembershipId) return false;
      const callerMembershipId = actorMembershipId(context);
      if (!callerMembershipId) return false;
      if (cosignerMembershipId === callerMembershipId) return false; // two distinct actors
      const callerIsSo = hasRole(context, ROLE_SECURITY_OFFICER);
      const callerIsCo = hasRole(context, ROLE_COMPLIANCE_OFFICER);
      if (!callerIsSo && !callerIsCo) return false;
      const cosignerRoles = await resolver.loadMemberRoleKeys(
        readContextOf(context),
        cosignerMembershipId,
      );
      const cosignerIsSo = cosignerRoles.includes(ROLE_SECURITY_OFFICER);
      const cosignerIsCo = cosignerRoles.includes(ROLE_COMPLIANCE_OFFICER);
      return (callerIsSo && cosignerIsCo) || (callerIsCo && cosignerIsSo);
    },

    // `actor.membership === mortality_review.assigned_reviewer_membership_id`. §4.7.
    assignedToMortality: async (context, target) => {
      const reviewId = targetStr(target, "reviewId");
      if (!reviewId) return false;
      const review = await resolver.loadMortalityReview(readContextOf(context), reviewId);
      if (!review) return false;
      const membershipId = actorMembershipId(context);
      if (!membershipId) return false;
      return review.assignedToMembershipId === membershipId;
    },

    // (M30-F14, ADR-0014 / SEC-046) The per-row redaction filter for Part-2-promoted rows. A row whose
    // `retention_class ≠ compliance_42cfr_part2` passes unconditionally; a Part-2-promoted row passes
    // iff the linked patient carries an M5 Part 2 PrivacyFlag AND a valid unexpired M39
    // `42_cfr_part_2_release` covers the actor's access. Default-deny / fail-closed: missing
    // retention_class, missing patient link, unreachable M5/M39 reach, or no covering release ⇒ false
    // (row redacted). §6.7. The M5/M39 reach is NOT in the M1 SeamContracts, so the Drizzle resolver's
    // two Part-2 loads return false — every Part-2-promoted row is redacted until those seams land.
    part2Redisclosure: async (context, target) => {
      const retentionClass = targetStr(target, "retentionClass");
      if (!retentionClass) return false; // route must supply the row's retention class → fail-closed
      if (retentionClass !== RETENTION_CLASS_PART2) return true; // not Part-2-promoted → pass
      const patientId = targetStr(target, "patientId");
      if (!patientId) return false; // Part-2 row with no resolvable patient link → redact
      const ctx = readContextOf(context);
      const protectedFlag = await resolver.isPatientPart2Protected(ctx, patientId);
      if (!protectedFlag) return false; // snapshot absent / unreachable → redact
      return resolver.part2ReleaseCoversActor(ctx, patientId);
    },
  };
}

/**
 * Register M30's eleven §4.7 ABAC predicate resolvers into M3's shared registry (idempotent). Call at
 * boot; the composition root passes `{ db }` so the predicates resolve owner facts under RLS (P2c). With
 * NO db handle it defaults to the {@link denyStubM30AbacResolver} so the predicates still EXIST (fail-
 * closed) at boot. Re-boot (tests) skips already-registered names (single-owner / no-clear; M33 / M34).
 */
export function registerM30AbacPredicates(deps: ReadingM30AbacDeps = {}): void {
  const predicates = buildM30AbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
