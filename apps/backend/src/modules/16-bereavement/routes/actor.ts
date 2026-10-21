// apps/backend/src/modules/16-bereavement/routes/actor.ts — M16-T06 route actor binding.
//
// The org/actor binding for every M16 route is ALWAYS server-side (the M2-assembled `request.context`,
// NEVER the body/query) — the single home for that extraction (the M15/M23/M24/M26 routes/actor.ts
// precedent). No handler reads an org id, an acting membership id, a session class or a portal account id
// off the wire. Every authored row (a contact, an outreach completion, a contact-log entry, a closure, a
// risk score) is stamped with the server-assembled membership id — the §6.1 spoofing control: a caller
// cannot record a condolence call as another counselor by putting their id in the body.
//
// The portal branch matters here in a way it does not in M15: §4.1 routes 14 / 15 are reachable by the
// bereaved person's OWN M31 session, so the actor carries `portalAccountId` for the `portal_self_service`
// gate — and a portal session carries no workforce membership, which is why {@link writeActorOf} would
// reject it. The two portal-self routes therefore use {@link mutatingActorOf}, which permits a portal
// session and leaves `membershipId` null so the opt-out row records `recorded_by_user_id = NULL` exactly
// as §3.3.8 specifies for the self-service path.
import { ForbiddenError, UnauthorizedError } from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";

/** A @chartwarden/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The READ-route actor: org + user + roles + the session facts the §4.8 predicates and §7.13 read. */
export interface M16ReadActor {
  readonly organizationId: string;
  readonly userId: string;
  /** The actor's ACTIVE M2 membership (null on a portal session, which carries none). */
  readonly membershipId: string | null;
  readonly roles: readonly string[];
  /** M2 session class (`staff` unless a portal/collaborator/auditor session). */
  readonly sessionClass: string;
  readonly locationIds: readonly string[];
  /** The M31 portal account behind a bereaved-family session; null for staff (§4.8 `portal_self_service`). */
  readonly portalAccountId: string | null;
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** Extract the org-scoped read actor from `request.context` (server-assembled), or 401. */
export function actorOf(request: FastifyRequest): M16ReadActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    membershipId: str(ctx.attributes?.membershipId),
    roles: ctx.roles,
    sessionClass: str(ctx.attributes?.sessionClass) ?? "staff",
    locationIds: ctx.locationIds,
    portalAccountId: str(ctx.attributes?.portalAccountId),
  };
}

/**
 * The MUTATING-route actor: the read actor PLUS the server-verified recent step-up flag
 * (`context.attributes.stepUpRecent`, §4.1 "step_up_fresh" on the two close routes). `membershipId` stays
 * nullable so the portal-self routes can use it; the staff-only routes go through {@link writeActorOf},
 * which narrows it.
 */
export interface M16MutatingActor extends M16ReadActor {
  /** True iff the session carries a recent (server-verified) step-up auth. */
  readonly stepUpRecent: boolean;
}

/** The staff write actor — same as {@link M16MutatingActor} but with a guaranteed membership. */
export interface M16WriteActor extends M16MutatingActor {
  readonly membershipId: string;
}

/** Extract the mutating actor. Permits a portal session (no membership) — see the module header. */
export function mutatingActorOf(request: FastifyRequest): M16MutatingActor {
  return {
    ...actorOf(request),
    stepUpRecent: request.context?.attributes?.stepUpRecent === true,
  };
}

/** Extract the STAFF write actor (org + user + membership + roles + step-up), or 401/403. */
export function writeActorOf(request: FastifyRequest): M16WriteActor {
  const actor = mutatingActorOf(request);
  if (actor.membershipId === null) {
    throw new ForbiddenError(
      "an M16 clinical write must be attributed to an active membership; this session carries none",
    );
  }
  return { ...actor, membershipId: actor.membershipId };
}
