// apps/backend/src/modules/35-subscription/routes/actor.ts — M35 (Subscription Billing) route actor binding.
//
// The org/actor binding for every M35 route is ALWAYS server-side (the M2-assembled `request.context`,
// NEVER the body/query). This is the single home for that extraction (the M27 routes/actor.ts precedent),
// so no handler reads an org id — or an authoring/approving membership id — off the wire. Every authored
// M35 row (subscription transition, payment-method change, refund request/approval, promo application) is
// stamped with the server-assembled membership id, never one supplied by the client. M35 carries NO PHI
// (§8.5) — every fact is ids + financial lifecycle state.
import { UnauthorizedError } from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";

/** A @chartwarden/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The READ-route actor: org + user + roles, all server-assembled from `request.context`. */
export interface M35ReadActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly roles: readonly string[];
}

/** Extract the org-scoped read actor from `request.context` (server-assembled), or 401. */
export function actorOf(request: FastifyRequest): M35ReadActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId, roles: ctx.roles };
}

/**
 * The MUTATING-route actor: the read actor PLUS the server-assembled active `membershipId` (the M2 session
 * attribute `context.attributes.membershipId`) and the recent-step-up flag
 * (`context.attributes.stepUpRecent`). Every M35 command stamps `membershipId` as the row's authoring /
 * acting principal — the requester on a refund request, the approver on `approve`, the actor on a
 * subscription transition. It is NEVER read off the body. `stepUpRecent` carries the §D14 server-verified
 * recent re-authentication used to gate the financial / platform mutations.
 */
export interface M35WriteActor extends M35ReadActor {
  readonly membershipId: string;
  /** True iff the session carries a recent (server-verified) step-up auth (§D14). */
  readonly stepUpRecent: boolean;
}

/** Extract the write actor (org + user + roles + active membership id + step-up) from `request.context`. */
export function writeActorOf(request: FastifyRequest): M35WriteActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  const membershipId = ctx.attributes?.membershipId;
  if (typeof membershipId !== "string" || membershipId.length === 0) {
    // No active membership on the session → cannot own/author an M35 row (fail-closed, never anonymous).
    throw new UnauthorizedError(
      "an active membership is required to author subscription-billing content",
    );
  }
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    roles: ctx.roles,
    membershipId,
    stepUpRecent: ctx.attributes?.stepUpRecent === true,
  };
}
