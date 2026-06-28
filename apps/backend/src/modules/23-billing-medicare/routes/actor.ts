// apps/backend/src/modules/23-billing-medicare/routes/actor.ts — M23 (Billing — Medicare) route actor
// binding (the M27 cost-report/routes/actor.ts precedent).
//
// The org/actor binding for every M23 route is ALWAYS server-side (the M2-assembled `request.context`,
// NEVER the body/query). This is the single home for that extraction, so no handler reads an org id — or an
// authoring/acting/overriding membership id — off the wire. Every authored M23 row (claim, claim_line,
// claim_submission, validation_override, mac_submitter_credential, sequestration_policy) is stamped with the
// server-assembled membership id, never one supplied by the client. M23 carries NO PHI and NEVER the MBI
// digit (D13 / §3.6 / §8.7).
//
// AI-BLOCK (D13): Module 32 cannot create/modify/witness/resolve any M23 row. The per-route
// `actor_kind='ai_*'` reject guard ({@link rejectAiActor}) is composed on every MUTATING route alongside
// the §4.6 permission + §4.7 ABAC gates, so an AI principal can never reach a write handler.
import { ForbiddenError, UnauthorizedError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/**
 * The READ-route actor: org + user + roles, all server-assembled from `request.context`. The GET routes
 * (claim list/detail/lines/history/submissions/acks, validation runs, NOE/NOTR list/detail, eligibility,
 * rule-config, sequestration-policy, MAC credentials, AR/metrics) compose over this. The eligibility +
 * caseload reads are audit-read-logged at the route guard; that gate does not change the actor shape.
 */
export interface M23ReadActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly roles: readonly string[];
}

/** Extract the org-scoped read actor from `request.context` (server-assembled), or 401. */
export function actorOf(request: FastifyRequest): M23ReadActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId, roles: ctx.roles };
}

/**
 * The MUTATING-route actor: the read actor PLUS the server-assembled active `membershipId` (the M2 session
 * attribute `context.attributes.membershipId`), the recent-step-up flag (`context.attributes.stepUpRecent`,
 * the §6 / §D14 server-verified re-authentication used to gate claim submit/replace/void + override +
 * MAC-credential admin), and the actor kind (`context.attributes.actorKind`) the §D13 AI-block enforces.
 * Every M23 command stamps `membershipId` as the row's authoring/acting principal —
 * `createdByMembershipId` on a claim, `overrideMembershipId` on a validation override,
 * `setByMembershipId` on a sequestration policy / MAC credential. It is NEVER read off the body.
 */
export interface M23WriteActor extends M23ReadActor {
  readonly membershipId: string;
  /** True iff the session carries a recent (server-verified) step-up auth (§6 / §D14). */
  readonly stepUpRecent: boolean;
  /** The acting principal kind (`user` / `system` / `ai_*`); the §D13 AI-block rejects every `ai_*`. */
  readonly actorKind: string;
}

/** Extract the write actor (org + user + roles + active membership + step-up + actor-kind), or 401/403. */
export function writeActorOf(request: FastifyRequest): M23WriteActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  const membershipId = ctx.attributes?.membershipId;
  if (typeof membershipId !== "string" || membershipId.length === 0) {
    // No active membership on the session → cannot own/author an M23 row (fail-closed, never anonymous).
    throw new UnauthorizedError("an active membership is required to author billing content");
  }
  const actorKind = typeof ctx.attributes?.actorKind === "string" ? ctx.attributes.actorKind : "user";
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    roles: ctx.roles,
    membershipId,
    stepUpRecent: ctx.attributes?.stepUpRecent === true,
    actorKind,
  };
}

/**
 * §D13 AI-BLOCK preHandler — refuse any request whose server-assembled `actor_kind` is an `ai_*` principal
 * BEFORE it reaches a mutating handler. Composed on every M23 write route. Fail-closed: an unknown/missing
 * actor kind is treated as a user (the kind is only ever `ai_*` when M32 set it), but any `ai_` prefix is
 * rejected with a structured 403.
 */
export function rejectAiActor(): PreHandler {
  return async (request) => {
    const kind = request.context?.attributes?.actorKind;
    if (typeof kind === "string" && kind.startsWith("ai_")) {
      throw new ForbiddenError("AI principals cannot create or modify billing records (D13)");
    }
  };
}
