// apps/backend/src/modules/30-quality/routes/actor.ts — M30 (HQRP & Quality) route actor binding.
//
// The org/actor binding for every M30 route is ALWAYS server-side (the M2-assembled `request.context`,
// NEVER the body/query). This is the single home for that extraction (the M33 routes/actor.ts +
// M34 routes/tenant/actor.ts precedent), so no handler reads an org id — or a reporter/triager/owner
// membership id — off the wire. Every authored M30 row (incident report, QAPI charter, SRA finding,
// infection event) is stamped with the server-assembled membership id, never one supplied by the client.
import { UnauthorizedError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * The READ-route actor: org + user + roles, all server-assembled from `request.context`. The R-* GET
 * routes (measures, CAHPS reads, QAPI/SRA reads, incident/mortality/infection lists, risk register)
 * compose over this. Patient-scoped reads additionally pass through `requirePatientScope()` at the route
 * guard — that gate does not change the actor shape, only whether the handler is reached.
 */
export interface M30ReadActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly roles: readonly string[];
}

/** Extract the org-scoped read actor from `request.context` (server-assembled), or 401. */
export function actorOf(request: FastifyRequest): M30ReadActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId, roles: ctx.roles };
}

/**
 * The MUTATING-route actor: the read actor PLUS the server-assembled active `membershipId` (the M2
 * session attribute `context.attributes.membershipId`). Every M30 command stamps this id as the row's
 * authoring/acting principal — `reportedByMembershipId` on an incident, `chargedByMembershipId` on a
 * QAPI charter, a co-signer id on a PIP/SRA close, the reviewer on a mortality completion. It is NEVER
 * read off the body: a write by an actor whose session carries no membership id is refused (403), since
 * the §4.7 ownership predicates (`ownsIncident`, `ownsQapiProject`, `ownsSraCycle`, the two-person
 * co-sign split) all key on this id.
 */
export interface M30WriteActor extends M30ReadActor {
  readonly membershipId: string;
}

/** Extract the write actor (org + user + roles + active membership id) from `request.context`, or 401/403. */
export function writeActorOf(request: FastifyRequest): M30WriteActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  const membershipId = ctx.attributes?.membershipId;
  if (typeof membershipId !== "string" || membershipId.length === 0) {
    // No active membership on the session → cannot own/author an M30 row (fail-closed, never anonymous).
    throw new UnauthorizedError("an active membership is required to author quality content");
  }
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    roles: ctx.roles,
    membershipId,
  };
}
