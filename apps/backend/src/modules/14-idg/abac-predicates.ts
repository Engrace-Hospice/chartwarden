// apps/backend/src/modules/14-idg/abac-predicates.ts — M14-T05 (§4.7).
//
// The three named ABAC predicate resolvers M14 OWNS and registers into M3's named-predicate registry (M3 §3.4).
// Each is a typed `(context, target) => boolean` evaluated server-side AFTER RBAC passes:
//
//   idg_meeting_scope  — §4.7: the meeting exists, is on the caller's tenant, and is at a LOCATION the caller's
//        session-assembled location memberships cover. The meeting id is the `:id` (or `:meetingId`) route
//        param; the facts load through the injected {@link IdgAbacResolver} (fail-closed if absent / cross-tenant
//        / out-of-scope). The auditor-under-engagement exception is the SHARED `auditor_engagement` predicate
//        (registered by M3) — composed at the route, not relaxed here.
//   quorate_decision  — §2.7 / §4.7: the disciplines PRESENT at the meeting right now satisfy the platform
//        `IDG_REQUIRED_QUORUM` (the pure `evaluateQuorum` / `decisionMeetsQuorum` decision from @wardenx/idg).
//        The meeting id is the `:id` route param; the present-discipline set loads through the resolver. A
//        non-quorate meeting may still be HELD (§1.1) — this predicate gates the DECISION write only.
//   per_patient_review_floor_clear  — M14-F01 / ADR-0018 D2 / §4.7: a CANCEL / RESCHEDULE leaves NO included
//        patient past their per-patient 15-day review floor (`last_idg_reviewed_at + 15d`) with no covering
//        meeting. The meeting id is the `:id` route param; the proposed transition + new start ride the body.
//        This is the BASE guard (allow when clear); the audited escape valve (an `idg.override_review_floor`
//        holder with fresh step-up) is composed at the route — the handler writes the audit_event + emits
//        `m14.review_floor.override_recorded`.
//
// The §4.1 read routes also carry the shared `caseload_or_scope` patient-scope predicate where a per-patient
// filter applies (registered by M5/M6/M7) — bound by USING the name at the route, not re-registered here.
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests) guards on
// `abacRegistry.has`.
import { type AbacContext, type AbacTarget, abacRegistry, registerPredicate } from "@wardenx/auth";
import { decisionMeetsQuorum, evaluateQuorum } from "@wardenx/idg";

/** The §4.7 predicate names M14 owns (registered into M3). Single-owner across the platform registry. */
export const M14_ABAC_PREDICATES = [
  "idg_meeting_scope",
  "quorate_decision",
  "per_patient_review_floor_clear",
] as const;

const targetStr = (target: AbacTarget, field: string): string | null => {
  const value = target[field];
  return typeof value === "string" && value.length > 0 ? value : null;
};

/** Lift the meeting id from the route target (`:id` for most routes; `:meetingId` for the packet read). */
function meetingIdOf(target: AbacTarget): string | null {
  return targetStr(target, "meetingId") ?? targetStr(target, "id");
}

/** The meeting-scope facts the resolver loads for a meeting (the org is RLS-pinned; the location drives scope). */
export interface MeetingScopeFacts {
  readonly organizationId: string;
  readonly locationId: string;
}

/** One included patient whose per-patient 15-day review floor a CANCEL/RESCHEDULE would leave uncovered. */
export interface ReviewFloorBreachFact {
  readonly patientId: string;
  readonly floorAt: string;
}

/** The read surface M14's ABAC predicates resolve against (the in-memory slice / Drizzle store implements it). */
export interface IdgAbacResolver {
  /** Meeting scope facts (org + location) for the meeting, or null when absent / cross-tenant. */
  loadMeetingScope(orgId: string, meetingId: string): Promise<MeetingScopeFacts | null>;
  /** The disciplines PRESENT at the meeting right now (drives the quorum evaluation), or null when absent. */
  loadPresentDisciplines(orgId: string, meetingId: string): Promise<readonly string[] | null>;
  /** The per-patient review-floor breaches a proposed CANCEL/RESCHEDULE would leave uncovered (empty = clear). */
  loadReviewFloorBreaches(
    orgId: string,
    meetingId: string,
    proposedTransition: "cancel" | "reschedule",
    newScheduledStart: string | null,
  ): Promise<readonly ReviewFloorBreachFact[]>;
}

/** Deps for M14's ABAC predicate resolvers (the slice injects an in-memory resolver over its dataset). */
export interface IdgAbacDeps {
  readonly resolver: IdgAbacResolver;
}

/**
 * Build M14's three §4.7 predicate resolvers over injected deps (pure factory — unit-tested with a fresh
 * registry; the boot path registers them via {@link registerIdgAbacPredicates}). The decision route's target
 * carries the meeting `:id`; the cancel/reschedule routes' target carries the meeting `:id` plus the body's
 * `proposedTransition` + `newScheduledStart`.
 */
export function buildIdgAbacPredicates(
  deps: IdgAbacDeps,
): Record<string, (context: AbacContext, target: AbacTarget) => Promise<boolean>> {
  const { resolver } = deps;
  return {
    idg_meeting_scope: async (context, target) => {
      const meetingId = meetingIdOf(target);
      if (!meetingId) return false; // no meeting named → deny (fail-closed)
      const facts = await resolver.loadMeetingScope(context.organizationId, meetingId);
      if (!facts) return false; // absent / cross-tenant (fail-closed)
      if (facts.organizationId !== context.organizationId) return false; // cross-tenant (defense in depth)
      return context.locationIds.includes(facts.locationId);
    },
    quorate_decision: async (context, target) => {
      const meetingId = meetingIdOf(target);
      if (!meetingId) return false; // no meeting named → deny (fail-closed)
      const present = await resolver.loadPresentDisciplines(context.organizationId, meetingId);
      if (present === null) return false; // absent / cross-tenant (fail-closed)
      return decisionMeetsQuorum(evaluateQuorum(present));
    },
    per_patient_review_floor_clear: async (context, target) => {
      const meetingId = meetingIdOf(target);
      if (!meetingId) return false; // no meeting named → deny (fail-closed)
      const transition = targetStr(target, "proposedTransition");
      if (transition !== "cancel" && transition !== "reschedule") return false; // unknown transition → deny
      const breaches = await resolver.loadReviewFloorBreaches(
        context.organizationId,
        meetingId,
        transition,
        targetStr(target, "newScheduledStart"),
      );
      // Base guard: clear when no included patient is left past their 15-day floor. The audited override
      // (idg.override_review_floor + fresh step-up) is composed at the route, not here.
      return breaches.length === 0;
    },
  };
}

/**
 * Register M14's three §4.7 ABAC predicate resolvers into M3's shared registry (M14-T05; idempotent). Call at
 * boot after the IDG route service is constructed (the resolver reads the same dataset). Re-boot (tests) skips
 * already-registered names (single-owner / no-clear).
 */
export function registerIdgAbacPredicates(deps: IdgAbacDeps): void {
  const predicates = buildIdgAbacPredicates(deps);
  for (const [name, predicate] of Object.entries(predicates)) {
    if (abacRegistry.has(name)) continue;
    registerPredicate(name, predicate);
  }
}
