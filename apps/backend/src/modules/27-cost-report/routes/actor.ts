// apps/backend/src/modules/27-cost-report/routes/actor.ts — M27 (Cost Report) route actor binding.
//
// The org/actor binding for every M27 route is ALWAYS server-side (the M2-assembled `request.context`,
// NEVER the body/query). This is the single home for that extraction (the M30 routes/actor.ts precedent),
// so no handler reads an org id — or an authoring/approving membership id — off the wire. Every authored
// M27 row (cost report, worksheet write, bad-debt entry, validation override, snapshot) is stamped with
// the server-assembled membership id, never one supplied by the client. M27 carries NO PHI (D18).
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * The READ-route actor: org + user + roles, all server-assembled from `request.context`. The GET routes
 * (cost-report list/detail, worksheets, mappings, imports, validations, snapshots, compliance window,
 * rule library) compose over this. Financial reads are audit-read-logged at the route guard; that gate
 * does not change the actor shape, only whether the handler is reached.
 */
export interface M27ReadActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly roles: readonly string[];
}

/** Extract the org-scoped read actor from `request.context` (server-assembled), or 401. */
export function actorOf(request: FastifyRequest): M27ReadActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId, roles: ctx.roles };
}

/**
 * The MUTATING-route actor: the read actor PLUS the server-assembled active `membershipId` (the M2
 * session attribute `context.attributes.membershipId`) and the recent-step-up flag
 * (`context.attributes.stepUpRecent`). Every M27 command stamps `membershipId` as the row's
 * authoring/acting principal — `addedByMembershipId` on a bad-debt entry, `overriddenByMembershipId` on a
 * validation override, `createdByMembershipId` on a snapshot, the approver on `approve_for_submit`, the
 * submitter on `submit`. It is NEVER read off the body. `stepUpRecent` carries the §D14 server-verified
 * recent re-authentication used to gate override / approve / submit / submit-past-deadline / reopen.
 */
export interface M27WriteActor extends M27ReadActor {
  readonly membershipId: string;
  /** True iff the session carries a recent (server-verified) step-up auth (§D14). */
  readonly stepUpRecent: boolean;
}

/** Extract the write actor (org + user + roles + active membership id + step-up) from `request.context`, or 401/403. */
export function writeActorOf(request: FastifyRequest): M27WriteActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  const membershipId = ctx.attributes?.membershipId;
  if (typeof membershipId !== "string" || membershipId.length === 0) {
    // No active membership on the session → cannot own/author an M27 row (fail-closed, never anonymous).
    throw new UnauthorizedError("an active membership is required to author cost-report content");
  }
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    roles: ctx.roles,
    membershipId,
    stepUpRecent: ctx.attributes?.stepUpRecent === true,
  };
}
