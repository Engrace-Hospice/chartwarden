// apps/backend/src/modules/17-scheduling/abac-predicates.ts — M17-T07 (§4.7).
//
// The four named ABAC predicate resolvers M17 OWNS and registers into M3's named-predicate registry (M3 §3.4)
// — predicates 2–5 of the §1.1 D8 pre-schedule gate (predicate 1 `clinician_membership_active` is M2's, the
// shared `volunteer_gate_satisfied` is M15 Phase-2, and `visit_overlap` is the §2.5 DB EXCLUDE backstop, so
// none of those are owned here). Each is a typed `(context, target) => Promise<boolean>` evaluated server-side
// AFTER RBAC passes, composed at the assignment-write routes (`POST /visits`, `PATCH /visits/:id` on a
// time/assignment change, `reschedule`, `reassign`, and proposal `publish`):
//
//   clinician_credentials_active       — §4.7: the membership holds every credential the visit purpose
//        requires, ACTIVE as of the service date. The required-set + active-as-of decision loads through the
//        injected {@link SchedulingAbacResolver} (prod wires M2's credential reader); fail-closed when the
//        membership/creds are unknown.
//   discipline_matches_visit           — §1.1 D8 predicate 3: the membership's discipline is acceptable for
//        the visit purpose per the pure `VISIT_PURPOSE_DISCIPLINES` map (@wardenx/scheduling). Fail-closed on
//        an unknown membership or an unknown purpose.
//   not_on_pto                         — §4.7: NO approved `time_off` row overlaps the scheduled window. The
//        overlap probe loads through the resolver (prod = the §4.7 `tstzrange && tstzrange` query under RLS).
//   within_caseload_or_unassigned_pool — §4.7: the org's `allow_unassigned_pool_assignment` policy is on, OR
//        the patient is in the membership's caseload. Fail-closed when neither holds.
//
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests) guards on
// `abacRegistry.has`.
import { type AbacContext, type AbacTarget, registerPredicateIdempotent } from "@wardenx/auth";
import { type SchedulingDiscipline, VISIT_PURPOSE_DISCIPLINES } from "@wardenx/scheduling";
import type { VisitPurpose } from "@wardenx/types";

/** The §4.7 predicate names M17 owns (registered into M3). Single-owner across the platform registry. */
export const M17_ABAC_PREDICATES = [
  "clinician_credentials_active",
  "discipline_matches_visit",
  "not_on_pto",
  "within_caseload_or_unassigned_pool",
] as const;

const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** Whether `purpose` is a known `VisitPurpose` (guards the discipline-matrix lookup, fail-closed on unknown). */
function isVisitPurpose(purpose: string): purpose is VisitPurpose {
  return purpose in VISIT_PURPOSE_DISCIPLINES;
}

/**
 * The read surface M17's ABAC predicates resolve against (the in-memory route service / Drizzle store
 * implements it). Every method is org-pinned and fail-closed by contract (return `false`/`null` on absent /
 * cross-tenant facts).
 */
export interface SchedulingAbacResolver {
  /** EVERY scheduling discipline the membership holds (drives `discipline_matches_visit`); empty when
   *  absent / cross-tenant. Plural on purpose: a membership can hold more than one discipline role, and
   *  collapsing that to a single arbitrary value made the predicate non-deterministic. */
  resolveDisciplines(orgId: string, membershipId: string): Promise<SchedulingDiscipline[]>;
  /** True when the membership holds every credential the purpose requires, ACTIVE as of `serviceDate`. */
  credentialsActiveForPurpose(
    orgId: string,
    membershipId: string,
    visitPurpose: VisitPurpose,
    serviceDate: string,
  ): Promise<boolean>;
  /** True when an APPROVED `time_off` row overlaps `[startsAt, endsAt)` for the membership (`not_on_pto` denies). */
  hasApprovedTimeOffOverlap(
    orgId: string,
    membershipId: string,
    startsAt: string,
    endsAt: string,
  ): Promise<boolean>;
  /** True when the org's `allow_unassigned_pool_assignment` policy opens the pool (caseload-strict otherwise). */
  allowsUnassignedPool(orgId: string): Promise<boolean>;
  /** True when the patient is in the membership's caseload. */
  isInCaseload(orgId: string, membershipId: string, patientId: string): Promise<boolean>;
}

/** Deps for M17's ABAC predicate resolvers (the slice injects an in-memory resolver over its dataset). */
export interface SchedulingAbacDeps {
  readonly resolver: SchedulingAbacResolver;
}

/**
 * Build M17's four §4.7 predicate resolvers over injected deps (pure factory — unit-tested with a fresh
 * registry; the boot path registers them via {@link registerSchedulingAbacPredicates}). The assignment-write
 * routes assemble the target from the body — `membershipId` (the assigned membership), `visitPurpose`,
 * `serviceDate`, `scheduledStartedAt`/`scheduledEndedAt`, and `patientId`.
 */
export function buildSchedulingAbacPredicates(
  deps: SchedulingAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  return {
    clinician_credentials_active: async (context, target) => {
      const membershipId = targetStr(target, "membershipId");
      const visitPurpose = targetStr(target, "visitPurpose");
      const serviceDate = targetStr(target, "serviceDate");
      if (!membershipId || !visitPurpose || !serviceDate) return false; // incomplete target → deny
      if (!isVisitPurpose(visitPurpose)) return false; // unknown purpose → deny
      return resolver.credentialsActiveForPurpose(
        context.organizationId,
        membershipId,
        visitPurpose,
        serviceDate,
      );
    },
    discipline_matches_visit: async (context, target) => {
      const membershipId = targetStr(target, "membershipId");
      const visitPurpose = targetStr(target, "visitPurpose");
      if (!membershipId || !visitPurpose) return false; // incomplete target → deny
      if (!isVisitPurpose(visitPurpose)) return false; // unknown purpose → deny
      const held = await resolver.resolveDisciplines(context.organizationId, membershipId);
      if (held.length === 0) return false; // absent / cross-tenant → deny
      return held.some((d) => VISIT_PURPOSE_DISCIPLINES[visitPurpose].includes(d));
    },
    not_on_pto: async (context, target) => {
      const membershipId = targetStr(target, "membershipId");
      const startsAt = targetStr(target, "scheduledStartedAt");
      const endsAt = targetStr(target, "scheduledEndedAt");
      if (!membershipId || !startsAt || !endsAt) return false; // incomplete target → deny
      const overlap = await resolver.hasApprovedTimeOffOverlap(
        context.organizationId,
        membershipId,
        startsAt,
        endsAt,
      );
      return !overlap; // no overlapping approved PTO → allow
    },
    within_caseload_or_unassigned_pool: async (context, target) => {
      const membershipId = targetStr(target, "membershipId");
      const patientId = targetStr(target, "patientId");
      if (!membershipId || !patientId) return false; // incomplete target → deny
      if (await resolver.allowsUnassignedPool(context.organizationId)) return true; // org opened the pool
      return resolver.isInCaseload(context.organizationId, membershipId, patientId);
    },
  };
}

/**
 * Register M17's four §4.7 ABAC predicate resolvers into M3's shared registry (M17-T07; idempotent). Call at
 * boot after the scheduling route service is constructed (the resolver reads the same dataset). Re-boot
 * (tests) skips already-registered names (single-owner / no-clear).
 */
export function registerSchedulingAbacPredicates(deps: SchedulingAbacDeps): void {
  const predicates = buildSchedulingAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    registerPredicateIdempotent(name, predicate);
  }
}
