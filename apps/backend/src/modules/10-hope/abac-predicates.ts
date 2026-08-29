import {
  type AbacContext,
  type AbacTarget,
  hasOrgWideScope,
  registerPredicateIdempotent,
} from "@wardenx/auth";
// apps/backend/src/modules/10-hope/abac-predicates.ts — M10-T06 (§4.7).
//
// The FOUR named ABAC predicate resolvers M10 OWNS and registers into M3's named-predicate registry (M3
// §3.4). Each is a typed `(context, target) => boolean` evaluated server-side AFTER RBAC passes:
//
//   hope.authorDisciplineAllowed   — D-decision: only RN / NP / MD may author/sign/correct a HOPE
//        timepoint. The actor's discipline set is assembled from session roles/attributes (never client
//        input). A discipline NOT in the set is a structural floor — break-glass cannot grant it (§6).
//   hope.sfvAuthorAllowed          — the CMS HOPE manual restricts the SFV (RFA-04) author further: only
//        RN / NP may sign an SFV completion.
//   hope.correctionAuthorAllowed   — the correction (§4.1 `/correct`) author must be the original signer
//        OR hold the clinical-lead role (broadened scope). The original-signer fact loads through the
//        injected {@link HopeAbacResolver} (org-scoped, RLS-backstopped); a missing/cross-tenant row
//        fails closed (deny).
//   hope.scope                    — GAP-018 (2026-08-09). This file's header USED TO claim the §4.1
//        `caseload` / `provider_entity` columns were "bound by the §4.6 default ABAC on each key,
//        enforced by M3's authorization middleware" — no such middleware exists anywhere in the codebase
//        (`requirePermission` only checks `granted.has(key)`; it never reads a permission's `defaultAbac`
//        catalog column). hope-routes.ts wired ZERO caseload/provider-entity guards as a result. M10's
//        routes name FIVE distinct id shapes across the 14 caseload-scoped + 5 provider-entity-scoped
//        routes (patientId / admissionId / scheduleId / sfvId / assessmentId, and providerEntityId /
//        submissionId) — none of which the shared `caseload_or_scope` (M7-owned; patientId/planId/`{}`)
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
import { isHopeAuthorDisciplineAllowed, isSfvAuthorDisciplineAllowed } from "@wardenx/hope";
import { getSeam } from "../../bootstrap/index";

/** The predicate names M10 owns (registered into M3). Single-owner across the platform registry. */
export const M10_ABAC_PREDICATES = [
  "hope.authorDisciplineAllowed",
  "hope.sfvAuthorAllowed",
  "hope.correctionAuthorAllowed",
  "hope.scope",
] as const;

/** Roles that read/scope any patient's HOPE data or any ProviderEntity's submissions without caseload/PE
 * membership (mirrors M7/M8/M9's `caseload_or_scope` org-wide escape). */
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
    const summary = await getSeam("AdmissionStatusReader").getAdmissionSummary(admissionId);
    if (summary.organizationId !== organizationId) return null; // cross-tenant — fail closed
    return { patientId: summary.patientId };
  } catch {
    return null; // seam absent/denying/gapped or admission unknown — fail closed (deny)
  }
};

/**
 * Build M10's four predicate resolvers over injected deps (pure factory — unit-tested with a fresh
 * registry; the boot path registers them via {@link registerHopeAbacPredicates}). The author/SFV routes
 * read the actor's discipline set from session context; `hope.correctionAuthorAllowed`'s target carries
 * the `:id` route param. `hope.scope`'s target reads exactly one of `patientId` / `admissionId` /
 * `scheduleId` / `sfvId` / (`assessmentId` or bare `id`, the default when a route names none of the
 * others) / `providerEntityId` / `submissionId` — every route wires exactly one shape via `getTarget`
 * (hope-routes.ts); an empty target (`{}`) is the optional-filter list/dashboard routes' "no filter
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

  const peOrScopeFor = (context: AbacContext, providerEntityId: string): boolean =>
    hasOrgWideScope(context.roles) || context.providerEntityIds.includes(providerEntityId);

  return {
    "hope.authorDisciplineAllowed": async (context) =>
      hopeDisciplinesOf(context).some((d) => isHopeAuthorDisciplineAllowed(d)),
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
      const patientId = targetStr(target, "patientId");
      if (patientId) return caseloadOrScopeFor(context, patientId);

      const admissionId = targetStr(target, "admissionId");
      if (admissionId) {
        const facts = await resolveAdmissionPatient(context.organizationId, admissionId);
        if (!facts) return false; // fail-closed (absent / cross-tenant / seam gap)
        return caseloadOrScopeFor(context, facts.patientId);
      }

      const scheduleId = targetStr(target, "scheduleId");
      if (scheduleId) {
        const facts = await resolver.loadSchedule(context.organizationId, scheduleId);
        if (!facts) return false; // fail-closed (absent / cross-tenant)
        return caseloadOrScopeFor(context, facts.patientId);
      }

      const sfvId = targetStr(target, "sfvId");
      if (sfvId) {
        const facts = await resolver.loadSfv(context.organizationId, sfvId);
        if (!facts) return false; // fail-closed (absent / cross-tenant)
        return caseloadOrScopeFor(context, facts.patientId);
      }

      const assessmentId = targetStr(target, "assessmentId") ?? targetStr(target, "id");
      if (assessmentId) {
        const facts = await resolver.loadAssessment(context.organizationId, assessmentId);
        if (!facts) return false; // fail-closed (absent / cross-tenant)
        return caseloadOrScopeFor(context, facts.patientId);
      }

      const providerEntityId = targetStr(target, "providerEntityId");
      if (providerEntityId) return peOrScopeFor(context, providerEntityId);

      const submissionId = targetStr(target, "submissionId");
      if (submissionId) {
        const facts = await resolver.loadSubmission(context.organizationId, submissionId);
        if (!facts) return false; // fail-closed (absent / cross-tenant)
        return peOrScopeFor(context, facts.providerEntityId);
      }

      // No scoping field at all — only the optional-filter list/dashboard routes (schedules,
      // submissions, compliance dashboard) construct an empty target, by the caller simply OMITTING
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
}
