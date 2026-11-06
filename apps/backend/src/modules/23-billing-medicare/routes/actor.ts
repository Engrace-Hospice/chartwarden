// apps/backend/src/modules/23-billing-medicare/routes/actor.ts — the M23 service-facing actor shapes and the
// one M23 extra over the route kit: the request envelope (correlation/request id, source ip, user agent)
// the claim-submission and DDE audit rows carry. Actor resolution itself is `@chartwarden/shared/route-kit`
// (org/user/membership from the server-assembled `request.context`, never the wire). M23 carries NO PHI and
// NEVER the MBI digit (D13 / §3.6 / §8.7).
import {
  type RouteActor,
  type WriteActor,
  writeActorOf as kitWriteActorOf,
} from "@chartwarden/shared/route-kit";
import type { FastifyRequest } from "fastify";

/** What an M23 read service needs of the route actor. */
export type M23ReadActor = Pick<RouteActor, "organizationId" | "userId" | "roles">;

/** What an M23 write service needs: the authoring membership, step-up, actor kind and request envelope. */
export interface M23WriteActor
  extends M23ReadActor,
    Pick<WriteActor, "membershipId" | "stepUpRecent" | "actorKind"> {
  readonly request?: {
    readonly correlationId?: string;
    readonly requestId?: string;
    readonly sourceIp?: string;
    readonly userAgent?: string;
  };
}

/** The kit write actor (401 without a session, 403 without a membership) plus the request envelope. */
export function writeActorOf(request: FastifyRequest): M23WriteActor {
  const actor = kitWriteActorOf(request);
  const ctx = request.context;
  return {
    ...actor,
    request: {
      ...(ctx?.correlationId ? { correlationId: ctx.correlationId } : {}),
      requestId: request.id,
      ...(ctx?.ip ? { sourceIp: ctx.ip } : {}),
      ...(ctx?.userAgent ? { userAgent: ctx.userAgent } : {}),
    },
  };
}
