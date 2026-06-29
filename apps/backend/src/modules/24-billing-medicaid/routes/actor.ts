// apps/backend/src/modules/24-billing-medicaid/routes/actor.ts — M24 (Billing — Medicaid) route actor
// binding. The org/actor binding for every M24 route is ALWAYS server-side (the M2-assembled
// `request.context`, NEVER the body/query) — the single home for that extraction (the M23/M26
// routes/actor.ts precedent). No handler reads an org id, an acting user id, a step-up flag, or the actor
// kind off the wire. Every authored row (a claim, a submission, an override, an R&B arrangement, a
// credential) is stamped with the server-assembled membership id.
//
// §8 / D12 — the `actor_kind='ai_*'` reject (`rejectAiActor`) is composed on every MUTATING M24 route
// alongside the §4.7 permission + §4.8 ABAC gates, so an AI principal can never reach a write handler.
import { ForbiddenError, UnauthorizedError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The READ-route actor: org + user + roles, all server-assembled from `request.context`. */
export interface M24ReadActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly roles: readonly string[];
}

/** Extract the org-scoped read actor from `request.context` (server-assembled), or 401. */
export function actorOf(request: FastifyRequest): M24ReadActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId, roles: ctx.roles };
}

/**
 * The MUTATING-route actor: the read actor PLUS the server-verified recent step-up flag
 * (`context.attributes.stepUpRecent`) used to gate submit / replace / void / arrangement activate-terminate
 * / override / credential upsert (D12). The acting user id is the stamped principal; it is NEVER read off
 * the body.
 */
export interface M24WriteActor extends M24ReadActor {
  /** True iff the session carries a recent (server-verified) step-up auth (D12). */
  readonly stepUpRecent: boolean;
}

/** Extract the write actor (org + user + roles + step-up) from `request.context`, or 401. */
export function writeActorOf(request: FastifyRequest): M24WriteActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    roles: ctx.roles,
    stepUpRecent: ctx.attributes?.stepUpRecent === true,
  };
}

/**
 * §8 / D12 AI-BLOCK preHandler — refuse any request whose server-assembled `actor_kind` is an `ai_*`
 * principal before it reaches a mutating M24 handler. The default actor kind is treated as a user (the kind
 * is only ever `ai_*` when M32 set it); any `ai_` prefix is rejected (no AI may assemble/submit/mutate a
 * Medicaid claim, R&B row, or credential).
 */
export function rejectAiActor(): PreHandler {
  return async (request) => {
    const kind = request.context?.attributes?.actorKind;
    if (typeof kind === "string" && kind.startsWith("ai_")) {
      throw new ForbiddenError("AI principals cannot create or modify Medicaid billing records (D12)");
    }
  };
}
