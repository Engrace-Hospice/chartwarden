// apps/backend/src/modules/36-messaging/routes/actor.ts - the M36 actor shapes, built on the route kit's actorOf.
// M36 attributes rows to the Better Auth user id, never a membership, so no route here needs writeActorOf.
import { actorOf } from "@chartwarden/shared/route-kit";
import { UnauthorizedError } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import type { GovernanceActor } from "../governance/retention-governance-service";

/** The `{ orgId, userId }` reference most M36 services take. */
export function actorRefOf(request: FastifyRequest): { orgId: string; userId: string } {
  const { organizationId, userId } = actorOf(request);
  return { orgId: organizationId, userId };
}

/** The actor plus the session id (offboarding, session devices); 401 when the session carries none. */
export function sessionActorOf(request: FastifyRequest): {
  organizationId: string;
  userId: string;
  sessionId: string;
} {
  const { organizationId, userId } = actorOf(request);
  const sessionId = request.context?.attributes?.sessionId;
  if (typeof sessionId !== "string" || sessionId === "") throw new UnauthorizedError();
  return { organizationId, userId, sessionId };
}

/** The governance actor with the audit context its writes record (retention governance, redaction). */
export function governanceActorOf(request: FastifyRequest): GovernanceActor {
  const { organizationId, userId, roles } = actorOf(request);
  const ctx = request.context;
  return {
    organizationId,
    userId,
    auditContext: {
      organizationId,
      userId,
      actorKind: "user",
      actorRole: roles[0],
      correlationId: ctx?.correlationId,
      requestId: String(request.id),
      sourceIp: ctx?.ip,
      userAgent: ctx?.userAgent,
    },
  };
}
