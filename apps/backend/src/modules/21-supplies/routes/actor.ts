// apps/backend/src/modules/21-supplies/routes/actor.ts — M21-T05 route actor binding.
//
// The org/actor binding for every M21 route is ALWAYS server-side (the M2-assembled `request.context`,
// NEVER the body/query) — the single home for that extraction (the M15/M16/M23/M24/M26 routes/actor.ts
// precedent). No handler reads an org id, an acting membership id or a Location set off the wire.
//
// This module has a sharper reason to care than most. Every controlled-substance column M21 writes is an
// ATTRIBUTION: `dispatched_by_membership_id`, `deployed_by_membership_id`, `delivered_by_membership_id`,
// `reconciled_by_membership_id`, `disposal_witness_membership_id`, `unreturnable_attested_by_membership_id`.
// Those six columns ARE the DEA 21 CFR §1304 chain of custody, and §4.4's separation-of-duties predicate
// compares them. A caller who could put someone else's membership id in the body could sign a morphine
// dispatch as a colleague and pass their own witness check. So the server stamps the actor, always — the
// ONE exception being `disposal_witness_membership_id`, which is by definition a SECOND person and
// therefore must come from the body; the §3.1.10 CHECK and the §4.4 predicate are what keep it honest.
import { ForbiddenError, UnauthorizedError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The READ-route actor: org + user + roles + the Location scope the §4.4 predicates compare against. */
export interface M21ReadActor {
  readonly organizationId: string;
  readonly userId: string;
  /** The actor's ACTIVE M2 membership (null on a session that carries none). */
  readonly membershipId: string | null;
  readonly roles: readonly string[];
  readonly locationIds: readonly string[];
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** Extract the org-scoped read actor from `request.context` (server-assembled), or 401. */
export function actorOf(request: FastifyRequest): M21ReadActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    membershipId: str(ctx.attributes?.membershipId),
    roles: ctx.roles,
    locationIds: ctx.locationIds,
  };
}

/**
 * The MUTATING-route actor: the read actor PLUS the server-verified recent step-up flag
 * (`context.attributes.stepUpRecent`). `membershipId` stays nullable here; the staff-only routes go
 * through {@link writeActorOf}, which narrows it.
 */
export interface M21MutatingActor extends M21ReadActor {
  /** True iff the session carries a recent (server-verified) step-up auth. */
  readonly stepUpRecent: boolean;
}

/** The staff write actor — same as {@link M21MutatingActor} but with a guaranteed membership. */
export interface M21WriteActor extends M21MutatingActor {
  readonly membershipId: string;
}

/** Extract the mutating actor (membership still nullable — see {@link writeActorOf}). */
export function mutatingActorOf(request: FastifyRequest): M21MutatingActor {
  return {
    ...actorOf(request),
    stepUpRecent: request.context?.attributes?.stepUpRecent === true,
  };
}

/**
 * Extract the STAFF write actor (org + user + membership + roles + step-up), or 401/403.
 *
 * EVERY M21 mutation goes through this, including the ones that look administrative (a par-stock
 * threshold edit, a routing-rule retirement). There is no anonymous or system-principal write path on the
 * HTTP surface: the §4.5.1 inbound cascades reach M21 through the outbox consumers, not through a route,
 * and they attribute their rows to the source event rather than to a human.
 */
export function writeActorOf(request: FastifyRequest): M21WriteActor {
  const actor = mutatingActorOf(request);
  if (actor.membershipId === null) {
    throw new ForbiddenError(
      "an M21 supply mutation must be attributed to an active membership; this session carries none",
    );
  }
  return { ...actor, membershipId: actor.membershipId };
}
