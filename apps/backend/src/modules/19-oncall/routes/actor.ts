// apps/backend/src/modules/19-oncall/routes/actor.ts — M19-T07 route actor binding.
//
// The org/actor binding for every M19 route is ALWAYS server-side (the M2-assembled `request.context`,
// NEVER the body/query) — the single home for that extraction (the M15/M16/M21/M24/M26 routes/actor.ts
// precedent). No handler reads an org id, an acting membership id, a session class or a vendor identity
// off the wire.
//
// FOUR FIELDS THIS MODULE CARES ABOUT MORE THAN MOST, AND WHY.
//
//   membershipId  — every attribution column M19 writes is a MEMBERSHIP:
//                   `triage_call_answer.answered_by_membership_id`, `triage_call_state_history
//                   .actor_membership_id`, `triage_escalation.resolved_by_membership_id`,
//                   `on_call_shift.primary_on_call_membership_id`. §8.3.3's repudiation controls are those
//                   columns, so a caller who could name someone else in a body could record a
//                   suicidal-ideation answer as a colleague.
//   sessionClass  — decides WHICH ABAC predicate the per-call routes evaluate (`guards.ts`
//                   `ABAC_CALL_ACTOR`) and whether the vendor PHI-minimization projection applies. §8.3.1's
//                   spoofing control is that it is an M2 session fact, not a header.
//   externalActorId — the vendor binding a vendor-class session is scoped to. Same argument, sharper: this
//                   IS the authorization subject for `external_triage_actor`, so reading it from anywhere
//                   a caller can write would make the predicate decorative.
//   discipline    — the §3.2 band the §7.3 / D6 disposition matrix is keyed on, DERIVED from the role keys
//                   M2 assembled. Not a claim, not a query param, and not a column: see
//                   `../abac-predicates.ts` for why the platform has no workforce-discipline read.
import { ForbiddenError, UnauthorizedError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  PORTAL_SESSION_CLASSES,
  VENDOR_SESSION_CLASSES,
  triageDisciplineForRoleKeys,
} from "../abac-predicates";
import { require_ } from "../lifecycle/errors";
import type { TriageActorDiscipline } from "../lifecycle/protocol";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The READ-route actor: org + user + roles + the scope facts the §4.7 predicates compare against. */
export interface M19ReadActor {
  readonly organizationId: string;
  readonly userId: string;
  /** The actor's ACTIVE M2 membership (null on a session that carries none — e.g. a portal session). */
  readonly membershipId: string | null;
  readonly roles: readonly string[];
  readonly providerEntityIds: readonly string[];
  readonly locationIds: readonly string[];
  /** The M2 session class (`staff` when unset). */
  readonly sessionClass: string;
  /** The `external_triage_vendor.id` a vendor-class session is bound to; null on every other class. */
  readonly externalActorId: string | null;
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** Extract the org-scoped read actor from `request.context` (server-assembled), or 401. */
export function actorOf(request: FastifyRequest): M19ReadActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    membershipId: str(ctx.attributes?.membershipId),
    roles: ctx.roles,
    providerEntityIds: ctx.providerEntityIds,
    locationIds: ctx.locationIds,
    sessionClass: str(ctx.attributes?.sessionClass) ?? "staff",
    externalActorId: str(ctx.attributes?.externalActorId),
  };
}

/** Is this an external triage VENDOR operator's session (§7.5 / D13)? */
export function isVendorActor(actor: M19ReadActor): boolean {
  return (VENDOR_SESSION_CLASSES as readonly string[]).includes(actor.sessionClass);
}

/** Is this a patient/caregiver PORTAL session (§4.1 row 36 / §5.3)? */
export function isPortalActor(actor: M19ReadActor): boolean {
  return (PORTAL_SESSION_CLASSES as readonly string[]).includes(actor.sessionClass);
}

/**
 * The MUTATING-route actor: the read actor PLUS the server-verified recent step-up flag
 * (`context.attributes.stepUpRecent`). `membershipId` stays nullable here; the staff-only routes go
 * through {@link writeActorOf}, which narrows it.
 */
export interface M19MutatingActor extends M19ReadActor {
  /** True iff the session carries a recent (server-verified) step-up auth (M2 SESSION_POLICY). */
  readonly stepUpRecent: boolean;
}

/** The staff/vendor write actor — same as {@link M19MutatingActor} but with a guaranteed membership. */
export interface M19WriteActor extends M19MutatingActor {
  readonly membershipId: string;
}

/** Extract the mutating actor (membership still nullable — see {@link writeActorOf}). */
export function mutatingActorOf(request: FastifyRequest): M19MutatingActor {
  return {
    ...actorOf(request),
    stepUpRecent: request.context?.attributes?.stepUpRecent === true,
  };
}

/**
 * Extract the WRITE actor (org + user + membership + roles + step-up), or 401/403.
 *
 * EVERY M19 route mutation goes through this. There is no anonymous or system-principal write path on the
 * HTTP surface: the §4.8 workers and the D10 inbound cascades reach M19 through their consumers, and those
 * attribute their rows to the source event (`triage_call_state_history.system_actor = true`) rather than to
 * a human. §3.3's `m19_triage_call_state_history_actor` CHECK is what makes the distinction structural — a
 * transition is either a named person's or explicitly the system's, never unattributed — and a route with
 * no membership behind it could satisfy neither arm honestly.
 *
 * A VENDOR-class session DOES carry a membership id (M2 mints one for the vendor operator inside the
 * tenant); what it does not carry is a clinical identity, which is why `../clinical/encounter-link` refuses
 * to let it author an M8 encounter (`ENCOUNTER_ACTOR_CANNOT_AUTHOR`).
 */
export function writeActorOf(request: FastifyRequest): M19WriteActor {
  const actor = mutatingActorOf(request);
  if (actor.membershipId === null) {
    throw new ForbiddenError(
      "an M19 triage mutation must be attributed to an active membership; this session carries none",
    );
  }
  return { ...actor, membershipId: actor.membershipId };
}

/**
 * §7.3 / D6 — the §3.2 discipline band this actor's disposition scope is decided against.
 *
 * A VENDOR session is `external` WHATEVER its role keys say. The tenant may well have granted the vendor
 * operator's membership an RN-shaped template so it can reach the triage routes at all; letting those role
 * keys resolve to `clinical_rn` would hand the vendor the full eight-disposition set that D13 gates to
 * in-agency clinicians, through a grant nobody intended as a scope decision. The session class is the
 * narrower and the more honest fact, so it wins.
 *
 * An actor whose keys evidence no band at all raises `TRIAGE_ACTOR_DISCIPLINE_UNRESOLVED` (403) rather than
 * defaulting: neither the widest band (obviously wrong) nor the narrowest (silently strands a real
 * clinician mid-call with no explanation) is a defensible guess.
 */
export function disciplineOf(actor: M19ReadActor): TriageActorDiscipline {
  if (isVendorActor(actor)) return "external";
  const band = triageDisciplineForRoleKeys(actor.roles);
  require_(
    band !== null,
    "TRIAGE_ACTOR_DISCIPLINE_UNRESOLVED",
    "this session's roles evidence no clinical discipline; the §7.3 scope-of-practice matrix cannot be evaluated for it",
  );
  return band;
}
