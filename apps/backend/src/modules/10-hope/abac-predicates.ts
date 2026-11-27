import {
  type AbacContext,
  type AbacTarget,
  type BreakGlassSubjectResolver,
  hasOrgWideScope,
  registerBreakGlassSubject,
  registerPredicateIdempotent,
  singleBreakGlassSubject,
} from "@chartwarden/auth";
// apps/backend/src/modules/10-hope/abac-predicates.ts — M10-T06 (§4.7).
//
// The FOUR named ABAC predicate resolvers M10 OWNS and registers into M3's named-predicate registry (M3
// §3.4). Each is a typed `(context, target) => boolean` evaluated server-side AFTER RBAC passes:
//
//   hope.authorDisciplineAllowed   — D-decision: only RN / NP / MD may author/sign/correct a HOPE
//        timepoint. The actor's discipline set is assembled from session roles/attributes (never client
//        input). A discipline NOT in the set is a structural floor — break-glass cannot grant it (§6).
//   hope.sfvAuthorAllowed          — the CMS HOPE manual limits the SFV (RFA-04) author: only
//        RN / NP / LPN / LVN may sign an SFV completion (HOPE Guidance Manual v1.03; the hospice decides
//        whether its LPN/LVNs are appropriate).
//   hope.correctionAuthorAllowed   — the correction (§4.1 `/correct`) author must be the original signer
//        OR hold the clinical-lead role (broadened scope). The original-signer fact loads through the
//        injected {@link HopeAbacResolver} (org-scoped, RLS-backstopped); a missing/cross-tenant row
//        fails closed (deny).
//   hope.scope                    — GAP-018 (2026-08-09). This file's header USED TO claim the §4.1
//        `caseload` / `provider_entity` columns were "bound by the §4.6 default ABAC on each key,
//        enforced by M3's authorization middleware" — no such middleware exists anywhere in the codebase
//        (`requirePermission` only checks `granted.has(key)`; it never reads a permission's `defaultAbac`
//        catalog column). hope-routes.ts wired ZERO caseload/provider-entity guards as a result. M10's
//        routes name seven distinct id shapes (the route table in hope-routes.ts is the route count): patientId /
//        admissionId / scheduleId / sfvId / assessmentId on the caseload-scoped routes and providerEntityId /
//        submissionId on the provider-entity-scoped ones — none of which the shared `caseload_or_scope` (M7-owned; patientId/planId/`{}`)
//        or `provider_entity_scope` (M3-intrinsic; providerEntityId only, no absent-target fallback for
//        the optional-filter list/dashboard routes) can resolve by name, and `requireAbac`'s `getTarget`
//        is synchronous so none of the non-`patientId`/non-`providerEntityId` ids can resolve inline. One
//        M10-owned predicate (mirrors M6/M8/M9's `admission.scope`/`encounter.scope`/`assessment.scope`)
//        handles every shape: the id-owning branches resolve to a patientId or providerEntityId
//        internally (via {@link HopeAbacResolver}, extended with `loadSchedule`/`loadSfv`/
//        `loadSubmission`, plus the published M6 `AdmissionStatusReader` seam for `admissionId` — M10 may
//        not import M6's schema, §11) before applying the same org-wide-role-escape ∨ caseload/PE
//        composition. An admissionId that the seam can't answer (absent/gapped/unregistered) fails
//        CLOSED (deny) — the opposite fail-direction from M9's capture-siting.ts, which fails OPEN on the
//        same seam because siting is a reporting denormalization, not a security gate.
//
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests) is
// idempotent via `registerPredicateIdempotent`.
import { isHopeAuthorDisciplineAllowed, isSfvAuthorDisciplineAllowed } from "@chartwarden/hope";
import { getSeam } from "../../bootstrap/index";
import { errorClassForLog, idForLog } from "./hope-log-id";
import { sameUuid } from "./hope-uuid";

/** The predicate names M10 owns (registered into M3). Single-owner across the platform registry. */
export const M10_ABAC_PREDICATES = [
  "hope.authorDisciplineAllowed",
  "hope.sfvAuthorAllowed",
  "hope.correctionAuthorAllowed",
  "hope.scope",
] as const;

/** The HOPE clinical-lead role token that may correct any signed assessment (§4.7 / §4.6). */
const CLINICAL_LEAD_ROLES = ["clinical_lead", "clinical_supervisor"] as const;

const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/**
 * Assemble the actor's HOPE discipline set from the session role keys (never client input), normalized to
 * the uppercase HOPE codes (`RN` / `NP` / `MD`) — the same source the route's discipline derivation reads.
 *
 * Derived from the ROLE KEYS M2 assembled onto the request context. It USED to union in an
 * `attributes.disciplines` array first; nothing in the platform has ever written that key, so the union was
 * with the empty set on every request ever served, and the role arm has been the whole answer all along
 * (F-030). See `07-care-plan/abac-predicates.ts` for the full argument.
 */
export function hopeDisciplinesOf(context: AbacContext): readonly string[] {
  return [...new Set(context.roles)].map((d) => d.toUpperCase());
}

/** The actor's active membership id off the M2-assembled session attributes (never the request body).
 *  Mirrors M7's `membershipIdOf` / M12's `actorOf` — the F-030 produced key. */
function membershipIdOf(context: AbacContext): string | null {
  const raw = context.attributes.membershipId;
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** Whether the actor holds the HOPE clinical-lead role (case-insensitive). */
function isClinicalLead(context: AbacContext): boolean {
  return context.roles.some((r) =>
    (CLINICAL_LEAD_ROLES as readonly string[]).includes(r.toLowerCase()),
  );
}

/** The original-signer + owning-patient facts M10's correction/scope predicates resolve for a target
 * assessment id (`patientId` added GAP-018 — `hope.scope`'s assessmentId branch). */
export interface HopeAssessmentAbacFacts {
  readonly patientId: string;
  readonly originalSignedBy: string | null;
  /** The record's RFA kind: lets the author-discipline predicate apply the SFV rule to an SFV's
   * draft-edit/sign/correct routes (#850). */
  readonly rfaKind: string;
  /** Frozen author attribution. Null only for legacy rows; edit/sign fail closed. */
  readonly authorDiscipline: string | null;
}

/** Loads a HOPE assessment's org-scoped signer + patient facts (in-memory in the slice; Drizzle in prod
 * under RLS), plus (GAP-018) the schedule/SFV/submission facts `hope.scope` resolves for their own id
 * shapes — each fails closed (`null`) on an absent / cross-tenant row. */
export interface HopeAbacResolver {
  loadAssessment(
    organizationId: string,
    assessmentId: string,
  ): Promise<HopeAssessmentAbacFacts | null>;
  loadSchedule(organizationId: string, scheduleId: string): Promise<{ patientId: string } | null>;
  loadSfv(organizationId: string, sfvId: string): Promise<{ patientId: string } | null>;
  loadSubmission(
    organizationId: string,
    submissionId: string,
  ): Promise<{ providerEntityId: string } | null>;
}

/** Deps for M10's ABAC predicate resolvers (the slice injects an in-memory resolver over its dataset). */
export interface HopeAbacDeps {
  readonly resolver: HopeAbacResolver;
  /** Caseload membership check (defaults to the boot-registered M5 `CaseloadProvider` seam). */
  readonly isInCaseload?: (q: {
    organizationId: string;
    userId: string;
    patientId: string;
  }) => Promise<boolean>;
  /** Resolves an admissionId to its owning patient (defaults to the published M6 `AdmissionStatusReader`
   * seam — M10 may not import M6's schema, §11). Fails CLOSED (`null`) on any seam error/absence/gap or
   * an admission belonging to a different org — `hope.scope` is a security gate, not a denormalization
   * (contrast M9's capture-siting.ts, which fails OPEN on the same seam for a reporting-only purpose). */
  readonly resolveAdmissionPatient?: (
    organizationId: string,
    admissionId: string,
  ) => Promise<{ patientId: string } | null>;
}

const defaultResolveAdmissionPatient = async (
  organizationId: string,
  admissionId: string,
): Promise<{ patientId: string } | null> => {
  try {
    const summary = await getSeam("AdmissionStatusReader").getAdmissionSummary(
      organizationId,
      admissionId,
    );
    if (summary.organizationId !== organizationId) return null; // cross-tenant — fail closed
    return { patientId: summary.patientId };
  } catch (error) {
    // Fail closed (deny): the seam is absent/denying/gapped or the admission is unknown. The caller answers 404 either
    // way, so during an M6 outage every admission-scoped HOPE route looks "not found"; the line below is the only trace of
    // why. An admission the seam simply does not know (a stale link, a typo, another tenant's id: M6 throws
    // `AdmissionNotFoundError` for an unknown or RLS-hidden id) is an ordinary 404 and logs nothing, so it cannot bury
    // the outage signal; M10 may not import M6's class, so it is recognised by name. Ids and the error CLASS only: a seam
    // failure's message can carry arbitrary text.
    if (error instanceof Error && error.name === "AdmissionNotFoundError") return null;
    console.warn(
      `m10: hope.scope denied: the M6 admission seam threw ${errorClassForLog(error)} resolving admission ${idForLog(admissionId)} (org ${idForLog(organizationId)}).`,
    );
    return null;
  }
};

type ResolveAdmissionPatient = NonNullable<HopeAbacDeps["resolveAdmissionPatient"]>;

/**
 * The patient a `hope.scope` target is about, in the order the predicate reads its fields: `patientId`, `admissionId`,
 * `scheduleId`, `sfvId`, then `assessmentId` / bare `id`. `undefined` = the target names no patient-bearing id (the
 * provider-entity / submission / empty-filter shapes); `null` = it names one that does not resolve (absent, another
 * tenant's, or an M6 seam gap). Shared by the predicate and by its break-glass subject resolver, so the patient a
 * glass is judged against is the patient the caseload was judged on.
 */
async function hopeScopePatientId(
  resolver: HopeAbacResolver,
  resolveAdmissionPatient: ResolveAdmissionPatient,
  organizationId: string,
  target: AbacTarget,
): Promise<string | null | undefined> {
  const [first] = hopePatientLookups(resolver, resolveAdmissionPatient, organizationId, target);
  return first ? first() : undefined;
}

/**
 * One lookup per patient-bearing field the target names, in the predicate's order (each resolves to the patient, or
 * `null` when absent / another tenant's / an M6 seam gap). The predicate runs only the FIRST; the break-glass subject
 * resolver runs ALL of them, so a target that names two patients is covered by neither's glass.
 */
function hopePatientLookups(
  resolver: HopeAbacResolver,
  resolveAdmissionPatient: ResolveAdmissionPatient,
  organizationId: string,
  target: AbacTarget,
): readonly (() => Promise<string | null>)[] {
  const lookups: Array<() => Promise<string | null>> = [];
  const patientId = targetStr(target, "patientId");
  if (patientId) lookups.push(async () => patientId);
  const admissionId = targetStr(target, "admissionId");
  if (admissionId)
    lookups.push(
      async () => (await resolveAdmissionPatient(organizationId, admissionId))?.patientId ?? null,
    );
  const scheduleId = targetStr(target, "scheduleId");
  if (scheduleId)
    lookups.push(
      async () => (await resolver.loadSchedule(organizationId, scheduleId))?.patientId ?? null,
    );
  const sfvId = targetStr(target, "sfvId");
  if (sfvId)
    lookups.push(async () => (await resolver.loadSfv(organizationId, sfvId))?.patientId ?? null);
  const assessmentId = targetStr(target, "assessmentId") ?? targetStr(target, "id");
  if (assessmentId)
    lookups.push(
      async () => (await resolver.loadAssessment(organizationId, assessmentId))?.patientId ?? null,
    );
  return lookups;
}

/**
 * Break-glass (CW-AC-03): the patient a `hope.scope` target belongs to, so an emergency grant over that patient opens
 * the HOPE assessment read like it opens the chart. A provider-entity or submission target belongs to no patient and
 * resolves to `null`: those stay refused. So does a target naming several patients, or one that does not resolve. The
 * grant only ever opens a GET (`requireAbac` refuses the branch for any other method).
 */
export function buildHopeBreakGlassSubject(deps: HopeAbacDeps): BreakGlassSubjectResolver {
  const resolveAdmissionPatient = deps.resolveAdmissionPatient ?? defaultResolveAdmissionPatient;
  return async (context, target) => {
    const lookups = hopePatientLookups(
      deps.resolver,
      resolveAdmissionPatient,
      context.organizationId,
      target,
    );
    return singleBreakGlassSubject(await Promise.all(lookups.map((lookup) => lookup())));
  };
}

/**
 * Build M10's four predicate resolvers over injected deps (pure factory — unit-tested with a fresh
 * registry; the boot path registers them via {@link registerHopeAbacPredicates}). The author/SFV routes
 * read the actor's discipline set from session context; `hope.correctionAuthorAllowed`'s target carries
 * the `:id` route param. `hope.scope` resolves the FIRST of `patientId` / `admissionId` / `scheduleId` / `sfvId` /
 * (`assessmentId` or bare `id`, the default when a route names none of the others) / `providerEntityId` /
 * `submissionId` that its target carries, in that order; a route's `getTarget` (hope-routes.ts) names the shape it
 * guards. An empty target (`{}`) is the optional-filter list/dashboard routes' "no filter
 * given" case and is an ORG-WIDE read, allowed only for the org-wide scope roles — the services apply
 * no PE/caseload narrowing when the filter is absent, so for everyone else the filter param IS the
 * scope claim and must be present (2026-08-14 review: an optional filter is not a scope).
 */
export function buildHopeAbacPredicates(
  deps: HopeAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  const isInCaseload = deps.isInCaseload ?? ((q) => getSeam("CaseloadProvider").isInCaseload(q));
  const resolveAdmissionPatient = deps.resolveAdmissionPatient ?? defaultResolveAdmissionPatient;

  const caseloadOrScopeFor = async (context: AbacContext, patientId: string): Promise<boolean> => {
    if (hasOrgWideScope(context.roles)) return true;
    if (!context.userId) return false;
    return isInCaseload({
      organizationId: context.organizationId,
      userId: context.userId,
      patientId,
    });
  };

  // The id named by the caller is compared with the actor's granted ids as the database reads a uuid, not on the
  // caller's spelling: an upper-case or braced spelling of the actor's own entity is the same entity. The exact match
  // stays for an id that is no uuid (it grants nothing the strings did not already).
  const peOrScopeFor = (context: AbacContext, providerEntityId: string): boolean =>
    hasOrgWideScope(context.roles) ||
    context.providerEntityIds.some(
      (granted) => granted === providerEntityId || sameUuid(granted, providerEntityId),
    );

  return {
    "hope.authorDisciplineAllowed": async (context, target) => {
      // An SFV's (RFA-04) correction draft is edited and signed on the generic assessment routes, so a
      // target naming an SFV row applies the SFV rule (LPN/LVN included). No target (new-timepoint
      // routes) or any other RFA keeps the RN/NP/MD floor. Unresolvable ids fall to the strict floor.
      const id = targetStr(target, "id") ?? targetStr(target, "assessmentId");
      const facts = id ? await resolver.loadAssessment(context.organizationId, id) : null;
      const allowed =
        facts?.rfaKind === "04_sfv" ? isSfvAuthorDisciplineAllowed : isHopeAuthorDisciplineAllowed;
      const actorDisciplines = hopeDisciplinesOf(context);
      if (!actorDisciplines.some((d) => allowed(d))) return false;
      // Existing-row writes preserve the record's frozen attribution: holding some other eligible
      // discipline is insufficient, and a pre-1452 NULL cannot silently acquire an attribution.
      if (id && (!facts?.authorDiscipline || !actorDisciplines.includes(facts.authorDiscipline))) {
        return false;
      }
      return true;
    },
    "hope.sfvAuthorAllowed": async (context) =>
      hopeDisciplinesOf(context).some((d) => isSfvAuthorDisciplineAllowed(d)),
    "hope.correctionAuthorAllowed": async (context, target) => {
      if (isClinicalLead(context)) return true;
      const id = targetStr(target, "id") ?? targetStr(target, "assessmentId");
      if (!id) return false;
      const facts = await resolver.loadAssessment(context.organizationId, id);
      if (!facts) return false; // fail-closed (absent / cross-tenant)
      // MEMBERSHIP to MEMBERSHIP. `originalSignedBy` is `hope_assessment.signed_by_membership_id`, and
      // this compared it to `context.userId` — two different id spaces that are never equal, so the
      // ORIGINAL SIGNER was denied their own correction on every request and only a clinical lead could
      // ever correct anything. GAP-026 is the same defect in M12, whose `actorOf` header already spells
      // out why the route suites stay green through it: their fixtures use one id for both.
      const actingMembershipId = membershipIdOf(context);
      if (actingMembershipId === null) return false; // no active membership → cannot own a row
      return facts.originalSignedBy != null && facts.originalSignedBy === actingMembershipId;
    },
    "hope.scope": async (context, target) => {
      // A patient-bearing id (patient / admission / schedule / SFV / assessment) is judged on its patient's caseload;
      // one that names a patient but does not resolve (absent / cross-tenant / seam gap) fails closed.
      const patientId = await hopeScopePatientId(
        resolver,
        resolveAdmissionPatient,
        context.organizationId,
        target,
      );
      if (patientId === null) return false;
      if (patientId !== undefined) return caseloadOrScopeFor(context, patientId);

      const providerEntityId = targetStr(target, "providerEntityId");
      if (providerEntityId) return peOrScopeFor(context, providerEntityId);

      const submissionId = targetStr(target, "submissionId");
      if (submissionId) {
        const facts = await resolver.loadSubmission(context.organizationId, submissionId);
        if (!facts) return false; // fail-closed (absent / cross-tenant)
        return peOrScopeFor(context, facts.providerEntityId);
      }

      // No scoping field at all — only the optional-filter list/dashboard routes (submissions,
      // compliance dashboard; the schedule list skips this gate and narrows by caseload in the handler) construct an empty target, by the caller simply OMITTING
      // the query param. An optional filter is not a scope: the services apply no PE/caseload
      // narrowing of their own when the filter is absent (RLS is org-level only), so an unfiltered
      // request is an org-wide read and only the org-wide scope roles may make one. Everyone else
      // must name the patient/PE they claim, which the branches above then verify. Fails closed on
      // a misconfigured route for the same reason (mirrors M8/M9's empty-target `return false`).
      return hasOrgWideScope(context.roles);
    },
  };
}

/**
 * Register M10's four ABAC predicate resolvers into M3's shared registry (M10-T06/GAP-018; idempotent).
 * Call at boot after the HOPE route service is constructed (the resolver reads the same dataset) and
 * after M5's `CaseloadProvider` seam registers (`hope.scope` resolves through it by default). Re-boot
 * (tests) skips already-registered names (single-owner / no-clear).
 */
export function registerHopeAbacPredicates(deps: HopeAbacDeps): void {
  const predicates = buildHopeAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
  registerBreakGlassSubject("hope.scope", buildHopeBreakGlassSubject(deps));
}
