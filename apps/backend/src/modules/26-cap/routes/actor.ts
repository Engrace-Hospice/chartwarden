// apps/backend/src/modules/26-cap/routes/actor.ts — M26 (Cap Management) route actor binding.
//
// The org/actor binding for every M26 route is ALWAYS server-side (the M2-assembled `request.context`,
// NEVER the body/query) — the single home for that extraction (the M25/M27 routes/actor.ts precedent). No
// handler reads an org id, an acting user id, or a step-up flag off the wire; every authored cap row (a
// period open/close, a methodology lock, a settlement, a PS&R import, a threshold ack) is stamped with the
// server-assembled user id. Platform-constant routes additionally require the platform_admin role.
import { UnauthorizedError } from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";

/** A @chartwarden/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The READ-route actor: org + user + roles, all server-assembled from `request.context`. */
export interface M26ReadActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly roles: readonly string[];
}

/** Extract the org-scoped read actor from `request.context` (server-assembled), or 401. */
export function actorOf(request: FastifyRequest): M26ReadActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId, roles: ctx.roles };
}

/**
 * The MUTATING-route actor: the read actor PLUS the server-verified recent step-up flag
 * (`context.attributes.stepUpRecent`) used to gate methodology-lock / settlement-finalize / year-reopen
 * (D12). The acting user id is the stamped principal; it is NEVER read off the body.
 */
export interface M26WriteActor extends M26ReadActor {
  /** True iff the session carries a recent (server-verified) step-up auth (D12). */
  readonly stepUpRecent: boolean;
}

/** Extract the write actor (org + user + roles + step-up) from `request.context`, or 401. */
export function writeActorOf(request: FastifyRequest): M26WriteActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    roles: ctx.roles,
    stepUpRecent: ctx.attributes?.stepUpRecent === true,
  };
}
