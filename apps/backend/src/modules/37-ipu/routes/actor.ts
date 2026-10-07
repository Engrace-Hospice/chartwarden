// apps/backend/src/modules/37-ipu/routes/actor.ts — M37 route actor binding. Org/actor/membership are
// ALWAYS server-assembled from `request.context` (the M35 routes/actor.ts precedent), never read off the
// wire; every authored M37 row is stamped with the server-assembled membership id.
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The READ-route actor: org + user + roles, all server-assembled. */
export interface IpuReadActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  /** The active membership id, when the session carries one (GAP-169: the `staff_member` roster match). */
  readonly membershipId?: string | null;
}

/** Extract the org-scoped read actor from `request.context`, or 401. */
export function actorOf(request: FastifyRequest): IpuReadActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  const membershipId = ctx.attributes?.membershipId;
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    roles: ctx.roles,
    membershipId: typeof membershipId === "string" && membershipId.length > 0 ? membershipId : null,
  };
}

/** The MUTATING-route actor: the read actor PLUS the active membership id + step-up flag. */
export interface IpuWriteActor extends IpuReadActor {
  readonly membershipId: string;
  readonly stepUpRecent: boolean;
  /**
   * GAP-106 — the M2 session id the step-up ceremony was performed on, from `context.attributes.sessionId`
   * (stamped by the authenticate hook from the verified session, never read off a request field). It is
   * the step-up assertion an attestation is bound to; null when the session carries none.
   */
  readonly stepUpAssertionId?: string | null;
}

/** Extract the write actor (org + user + roles + active membership id + step-up) from `request.context`. */
export function writeActorOf(request: FastifyRequest): IpuWriteActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  const membershipId = ctx.attributes?.membershipId;
  if (typeof membershipId !== "string" || membershipId.length === 0) {
    throw new UnauthorizedError("an active membership is required to author IPU content");
  }
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    roles: ctx.roles,
    membershipId,
    stepUpRecent: ctx.attributes?.stepUpRecent === true,
    stepUpAssertionId:
      typeof ctx.attributes?.sessionId === "string" && ctx.attributes.sessionId.length > 0
        ? ctx.attributes.sessionId
        : null,
  };
}
