// apps/backend/src/modules/25-remittance/routes/actor.ts — M25 (Remittance & Denials) route actor binding.
//
// The org/actor binding for every M25 route is ALWAYS server-side (the M2-assembled `request.context`,
// NEVER the body/query) — the single home for that extraction (the M27/M30 routes/actor.ts precedent). No
// handler reads an org id, an acting membership id, or a step-up flag off the wire. Every authored M25 row
// (a manual-match, a denial assignment/transition, an appeal transition, an overlay edit) is stamped with
// the server-assembled membership id. The internal seam routes (§4.1 #29-31) additionally require the
// `m25.system_principal` attribute (architecture §17 service-to-service token).
import { UnauthorizedError } from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import { BROAD_DENIAL_SCOPE_ROLES } from "../abac-predicates";

/** A @chartwarden/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The READ-route actor: org + user + roles, all server-assembled from `request.context`. */
export interface M25ReadActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly roles: readonly string[];
  /**
   * SERVER-DERIVED provider-entity scope (GAP-073 / GAP-148): `undefined` = unrestricted (an org-wide
   * oversight role or the service principal); an array restricts the actor to exactly those ProviderEntities,
   * and an EMPTY array matches nothing (fail-closed). Never read off the body/query.
   */
  readonly providerEntityScope?: readonly string[];
}

/** Extract the org-scoped read actor from `request.context` (server-assembled), or 401. */
export function actorOf(request: FastifyRequest): M25ReadActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    roles: ctx.roles,
    providerEntityScope: providerEntityScopeOf(ctx),
  };
}

/**
 * The MUTATING-route actor: the read actor PLUS the server-assembled active `membershipId` (the M2 session
 * attribute `context.attributes.membershipId`) and the recent step-up flag (`context.attributes.stepUpRecent`).
 * Every M25 command stamps `membershipId` as the acting principal (the manual-matcher, the assignee/assigner,
 * the appeal submitter/decider, the overlay editor); it is NEVER read off the body. `stepUpRecent` carries
 * the §D15 server-verified recent re-authentication used to gate adjustment-override / appeal.submit /
 * denial.close_with_write_off.
 */
export interface M25WriteActor extends M25ReadActor {
  readonly membershipId: string;
  /** True iff the session carries a recent (server-verified) step-up auth (§D15). */
  readonly stepUpRecent: boolean;
}

/** Extract the write actor (org + user + roles + active membership id + step-up) from `request.context`, or 401. */
export function writeActorOf(request: FastifyRequest): M25WriteActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  const membershipId = ctx.attributes?.membershipId;
  if (typeof membershipId !== "string" || membershipId.length === 0) {
    throw new UnauthorizedError("an active membership is required to act on remittance content");
  }
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    roles: ctx.roles,
    membershipId,
    stepUpRecent: ctx.attributes?.stepUpRecent === true,
    providerEntityScope: providerEntityScopeOf(ctx),
  };
}

/** Oversight roles + the service principal are org-wide; everyone else is limited to their membership's PEs. */
function providerEntityScopeOf(
  ctx: NonNullable<FastifyRequest["context"]>,
): readonly string[] | undefined {
  if (ctx.attributes?.actorKind === "system") return undefined;
  if (BROAD_DENIAL_SCOPE_ROLES.some((r) => ctx.roles.includes(r))) return undefined;
  return ctx.providerEntityIds ?? [];
}
