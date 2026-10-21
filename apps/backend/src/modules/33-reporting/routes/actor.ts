// apps/backend/src/modules/33-reporting/routes/actor.ts — M33 route actor binding.
//
// The org/actor binding for every M33 route is ALWAYS server-side (the M2-assembled `request.context`,
// NEVER the body/query). This is the single home for that extraction (the M34 routes/tenant/actor.ts
// precedent), so no handler reads an org id off the wire.
import { UnauthorizedError } from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { M33ReadActor } from "./read-service";

/** A @chartwarden/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * Extract the org-scoped actor from `request.context` (server-assembled), or 401.
 *
 * Carries the active `membershipId` when the session has one, because the §4.7.1 `self` scope IS that
 * membership id and the read path now narrows on it (F-059). Absent, `self` resolves over an empty set
 * and the tile denies — the same fail-closed answer `reportable_scope` itself gives an actor it cannot
 * scope-filter.
 */
export function actorOf(request: FastifyRequest): M33ReadActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  const membershipId = ctx.attributes?.membershipId;
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    roles: ctx.roles,
    ...(typeof membershipId === "string" && membershipId.length > 0 ? { membershipId } : {}),
  };
}

/**
 * The MUTATING-route actor: the read actor PLUS the server-assembled active `membershipId` (M2 session
 * attribute, `context.attributes.membershipId`) — the owner stamped onto a definition / view / schedule.
 * NEVER read off the body. A write by an actor whose session carries no membership id is refused (403),
 * since every authored row needs an owner membership for the §4.7.2 `dashboard_visibility` ladder.
 */
export interface M33WriteActor extends M33ReadActor {
  readonly membershipId: string;
}

/** Extract the write actor (org + user + roles + active membership id) from `request.context`, or 401/403. */
export function writeActorOf(request: FastifyRequest): M33WriteActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  const membershipId = ctx.attributes?.membershipId;
  if (typeof membershipId !== "string" || membershipId.length === 0) {
    // No active membership on the session → cannot own an authored row (fail-closed, never anonymous-author).
    throw new UnauthorizedError("an active membership is required to author reporting content");
  }
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    roles: ctx.roles,
    membershipId,
  };
}
