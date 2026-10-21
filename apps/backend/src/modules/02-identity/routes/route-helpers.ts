// apps/backend/src/modules/02-identity/routes/route-helpers.ts — the small request helpers the M2 identity route
// files share (extracted from identity-routes.ts so `link-routes.ts` can use them without an import cycle).
import type { AuditContext } from "@wardenx/audit";
import { UnauthorizedError, ValidationError, ChartWardenError } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import type { Actor, IdentityRouteDeps, LinkError } from "../identity-ports";

/** A 503 envelope: the dependency this route needs is not bound in this deployment (fail closed). */
export const unavailable = (code: string, message: string): ChartWardenError =>
  new ChartWardenError(code, message, 503);

/** Map a store LinkError to the spec's HTTP code (§4.2 collaborators/consume, §7.12). */
export function linkErrorToHttp(err: LinkError): ChartWardenError {
  if (err.kind === "used") return new ChartWardenError("LINK_ALREADY_USED", err.message, 409);
  if (err.kind === "verification_required")
    return new ChartWardenError("VERIFICATION_REQUIRED", err.message, 401);
  return new ChartWardenError("LINK_EXPIRED", err.message, 410);
}

/** Resolve the authenticated actor or fail closed (401 envelope). */
export async function resolveActor(
  deps: IdentityRouteDeps,
  request: FastifyRequest,
): Promise<Actor> {
  const actor = await deps.actors.resolve(request);
  if (!actor) throw new UnauthorizedError();
  return actor;
}

/** Build the audit context for an identity event from the request + scope. */
export function auditContextFor(
  request: FastifyRequest,
  scope: {
    organizationId: string | null;
    userId: string | null;
    actorKind?: AuditContext["actorKind"];
  },
): AuditContext {
  return {
    organizationId: scope.organizationId,
    userId: scope.userId,
    actorKind: scope.actorKind ?? "user",
    correlationId: request.context.correlationId,
    requestId: String(request.id),
    sourceIp: request.context.ip,
    userAgent: request.context.userAgent,
  };
}

/** Publish through `deps.outbox` if bound — record-only until a consumer is declared. */
export function publishM2(
  deps: IdentityRouteDeps,
  input: {
    eventName: string;
    payload: Record<string, unknown>;
    organizationId: string | null;
    aggregateKind: string;
    aggregateId: string;
  },
): Promise<void> {
  return deps.outbox?.publish(input) ?? Promise.resolve();
}

/** Read a required string field from a request body (flat VALIDATION_FAILED on miss). */
export function readString(body: unknown, field: string): string {
  const value = (body as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`invalid ${field}`, [
      { field, code: "REQUIRED", message: `${field} is required` },
    ]);
  }
  return value;
}
