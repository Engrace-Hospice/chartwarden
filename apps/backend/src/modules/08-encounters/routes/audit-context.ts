// apps/backend/src/modules/08-encounters/routes/audit-context.ts — the request's audit context for an M8 route that writes an explicit audit event
// (the draft section PUTs, the addendum sign). The actor and tenant are the server-assembled session, never request input.
import type { AuditContext } from "@chartwarden/audit";
import type { FastifyRequest } from "fastify";

export function auditContextOf(request: FastifyRequest): AuditContext {
  const ctx = request.context;
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    actorKind: "user",
    correlationId: ctx.correlationId,
    requestId: String(request.id),
    sourceIp: ctx.ip,
    userAgent: ctx.userAgent,
  };
}
