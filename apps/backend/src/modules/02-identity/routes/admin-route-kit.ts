// apps/backend/src/modules/02-identity/routes/admin-route-kit.ts — the few helpers every GAP-115 org-admin
// route shares: the authenticated-actor resolution, the server-side org binding (§7.12), the audit context, and
// the `m2.*` outbox publish. Kept beside the routes (not in identity-routes.ts, which keeps its own private
// copies) so the new files stay small and the two cannot be confused.
import type { AuditContext, AuditExecutor } from "@wardenx/audit";
import { UnauthorizedError, ValidationError, WardenXError } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import type { Actor, ActorResolver, IdentityOutboxPort } from "../identity-ports";

export interface AdminRouteDeps {
  readonly actors: ActorResolver;
  readonly audit: AuditExecutor;
  readonly outbox?: IdentityOutboxPort;
}

/** Resolve the authenticated actor or fail closed (401 envelope). */
export async function resolveActor(deps: AdminRouteDeps, request: FastifyRequest): Promise<Actor> {
  const actor = await deps.actors.resolve(request);
  if (!actor) throw new UnauthorizedError();
  return actor;
}

/** The acting admin's bound org must equal the path org (server-side org binding, §7.12). */
export function assertOrgMatch(request: FastifyRequest, pathOrgId: string): void {
  if (request.context.organizationId !== pathOrgId)
    throw new WardenXError("FORBIDDEN", "admin actions are scoped to the bound org", 403);
}

export function auditContextFor(request: FastifyRequest, actor: Actor): AuditContext {
  return {
    organizationId: actor.organizationId,
    userId: actor.userId,
    actorKind: "user",
    correlationId: request.context.correlationId,
    requestId: String(request.id),
    sourceIp: request.context.ip,
    userAgent: request.context.userAgent,
  };
}

/** Publish through the bound `m2.*` outbox; record-only (a no-op) when none is bound. */
export function publishM2(
  deps: AdminRouteDeps,
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

export const notFound = (what: string) => new WardenXError("NOT_FOUND", `${what} not found`, 404);

export function invalid(field: string, message: string): never {
  throw new ValidationError(message, [{ field, code: "INVALID", message }]);
}

/** A string field's trimmed value, or `undefined` when absent; 422 when present but not a string. */
export function optionalString(
  body: Record<string, unknown>,
  field: string,
  max = 200,
): string | undefined {
  const v = body[field];
  if (v === undefined) return undefined;
  if (typeof v !== "string") return invalid(field, `${field} must be a string`);
  const t = v.trim();
  if (t.length > max) return invalid(field, `${field} must be at most ${max} characters`);
  return t;
}

export function requiredString(body: Record<string, unknown>, field: string, max = 200): string {
  const v = optionalString(body, field, max);
  if (v === undefined || v === "") return invalid(field, `${field} is required`);
  return v;
}

export const asBody = (b: unknown): Record<string, unknown> =>
  typeof b === "object" && b !== null && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
