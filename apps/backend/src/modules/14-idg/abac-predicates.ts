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
//        `IDG_REQUIRED_QUORUM` (the pure `evaluateQuorum` / `decisionMeetsQuorum` decision from @chartwarden/idg).
//        The meeting id is the `:id` route param; the present-discipline set loads through the resolver. A
//        non-quorate meeting may still be HELD (§1.1) — this predicate gates the DECISION write only.
//   per_patient_review_floor_clear  — M14-F01 / ADR-0018 D2 / §4.7: a CANCEL / RESCHEDULE leaves NO included
//        patient past their per-patient 15-day review floor (`last_idg_reviewed_at + 15d`) with no covering
//        meeting. The meeting id is the `:id` route param; the proposed transition + new start ride the body.
//        This is the BASE guard (allow when clear). [GAP-091 CLOSED] When a real breach is found, the
//        predicate ITSELF resolves the audited escape valve inline (mirrors the M14 spec's own §4.7
//        pseudocode, which composes `ctx.hasPermission(...)`/`ctx.stepUpFresh()` inside this SAME predicate,
//        not as a second OR-composed preHandler — Fastify preHandlers AND, they cannot express "require X
//        only when Y already failed"): the actor must hold `idg.override_review_floor`
//        (`resolveActorPermissions`, the documented "check, don't gate" seam @chartwarden/auth exports for
//        exactly this) AND have a FRESH step-up per the platform `STEP_UP_POLICY`, resolved via M2's
//        published `SessionContextResolver` seam + the pure `isStepUpRecent` decision — the SAME real,
//        server-verified mechanism M3's own `step_up_recent` predicate uses (never a client-supplied
//        header — the ADJOURN route's `x-step-up: fresh` header WAS a different, pre-existing shortcut this
//        fix did not repeat; F-028 has since removed it, and adjourn resolves the same server-verified way).
//        On allow-via-override the predicate flags
//        `context.attributes[REVIEW_FLOOR_OVERRIDE_ATTRIBUTE] = true` — the SAME object `requireAbac`'s
//        break-glass branch already mutates for the handler to read, since `AbacContext.attributes` is
//        `request.context.attributes` by reference (not cloned) — so the route handler knows to pass
//        `overrideAuthorized: true` into the service, which writes the M4-audited outbox event
//        (`m14.review_floor.override_recorded`, capturing the breaching `{patientId, floorAt}[]` set + the
//        reason) and feeds `overrideAuthorized` into the pure `transitionMeeting` guard for real
//        defense-in-depth (GAP-020's own `cancelMeeting`/`rescheduleMeeting` fix).
//
// The §4.1 read routes also carry the shared `caseload_or_scope` patient-scope predicate where a per-patient
// filter applies (registered by M5/M6/M7) — bound by USING the name at the route, not re-registered here.
// Registration is idempotent: the shared registry is single-owner / no-clear, so re-boot (tests) guards on
// `abacRegistry.has`.
import {
  type AbacContext,
  type AbacTarget,
  hasOrgWideScope,
  isStepUpRecent,
  registerPredicateIdempotent,
  resolveActorPermissions,
} from "@chartwarden/auth";
import { decisionMeetsQuorum, evaluateQuorum } from "@chartwarden/idg";
import { STEP_UP_POLICY } from "@chartwarden/types";
import { getSeam } from "../../bootstrap/index";

/** GAP-091 — flagged on `AbacContext.attributes` (same object reference as `request.context.attributes`)
 * when `per_patient_review_floor_clear` allows a REAL breach through the audited override, so the route
 * handler knows to pass `overrideAuthorized: true` into the service call and expect the override recorded. */
export const REVIEW_FLOOR_OVERRIDE_ATTRIBUTE = "idg.reviewFloorOverrideAuthorized";

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
  /** GAP-091 — injectable clock for the override's step-up-freshness check (deterministic tests); defaults
   * to wall-clock, mirroring M3's own `registerAuthorizationAbacPredicates({ now })`. */
  readonly now?: () => number;
}

/** The M14-contributed permission key the audited review-floor override requires (packages/auth's
 * `contributed.ts`; GAP-091 — previously registered but never checked anywhere). */
const OVERRIDE_REVIEW_FLOOR_PERMISSION = "idg.override_review_floor";

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
  const now = deps.now ?? (() => Date.now());
  return {
    idg_meeting_scope: async (context, target) => {
      const meetingId = meetingIdOf(target);
      if (!meetingId) return false; // no meeting named → deny (fail-closed)
      const facts = await resolver.loadMeetingScope(context.organizationId, meetingId);
      if (!facts) return false; // absent / cross-tenant (fail-closed)
      if (facts.organizationId !== context.organizationId) return false; // cross-tenant (defense in depth)
      return hasOrgWideScope(context.roles) || context.locationIds.includes(facts.locationId);
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
      // Base guard: clear when no included patient is left past their 15-day floor.
      if (breaches.length === 0) return true;
      // GAP-091 — the audited escape valve: idg.override_review_floor + a FRESH step-up, both resolved
      // server-side (never client input). "Check, don't gate" — resolveActorPermissions is @chartwarden/auth's
      // documented seam for exactly this (an ABAC predicate that needs a permission fact, not a gate).
      const granted = await resolveActorPermissions(context);
      if (!granted.has(OVERRIDE_REVIEW_FLOOR_PERMISSION)) return false;
      const sessionId =
        typeof context.attributes.sessionId === "string" ? context.attributes.sessionId : null;
      if (!sessionId) return false; // fail-closed — mirrors M3's own step_up_recent predicate
      const stepUpState = await getSeam("SessionContextResolver").resolveStepUpState(
        { orgId: context.organizationId },
        sessionId,
      );
      if (!isStepUpRecent(stepUpState, STEP_UP_POLICY, now())) return false;
      // Flag the SAME attributes object `request.context.attributes` references (the break-glass-flag
      // precedent in require-abac.ts) so the route handler knows this allow was an override.
      context.attributes[REVIEW_FLOOR_OVERRIDE_ATTRIBUTE] = true;
      return true;
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
    registerPredicateIdempotent(name, predicate);
  }
}
