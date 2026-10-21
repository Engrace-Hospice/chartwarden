// apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/actor.ts — M34 tenant-route actor helper.
//
// Resolves the server-side actor facts the tenant-scoped handlers compose over: the active org + user +
// roles + the M2 membership id (the route layer binds the active membership into
// `context.attributes.membershipId`, the same fact the §4.6 ABAC predicates read). Org binding is
// SERVER-SIDE (`request.context`, never the body) — the M22 `actorOf` precedent.
import { UnauthorizedError } from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";

/** A @chartwarden/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface TenantActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  /** The active M2 membership id (server-assembled session attribute); "" if absent. */
  readonly membershipId: string;
}

export function actorOf(request: FastifyRequest): TenantActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  const m = ctx.attributes?.membershipId;
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    roles: ctx.roles,
    membershipId: typeof m === "string" ? m : "",
  };
}
