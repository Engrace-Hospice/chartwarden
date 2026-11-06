// @chartwarden/shared/route-kit — the route actor. The org and actor of every request are read from the
// server-assembled `request.context` (M1 request-context + M2 authenticate), never from the body or query.
import { ForbiddenError, type HttpRequestContext, UnauthorizedError } from "@chartwarden/types";

/** Anything carrying the M1 request context (a FastifyRequest does). */
export interface ContextCarrier {
  readonly context?: HttpRequestContext;
}

/** The authenticated actor of a request. */
export interface RouteActor {
  readonly organizationId: string;
  /** The Better Auth user id. */
  readonly userId: string;
  /** The actor's active M2 membership in this org; null on a session that carries none (portal, auditor). */
  readonly membershipId: string | null;
  readonly roles: readonly string[];
  readonly locationIds: readonly string[];
  /** M2 session class (`staff` unless a portal/collaborator/auditor session). */
  readonly sessionClass: string;
  /** `user`, or an `ai_*` principal M32 stamped. */
  readonly actorKind: string;
  /** True iff the session carries a recent, server-verified step-up. */
  readonly stepUpRecent: boolean;
}

/** A {@link RouteActor} that is guaranteed to carry a membership (every authored write). */
export interface WriteActor extends RouteActor {
  readonly membershipId: string;
}

/** The actor a membership-attributed row is written by: `userId` IS the membership id (the M7–M11 columns). */
export interface MembershipActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly roles: readonly string[];
}

/**
 * The `userId` an outbox consumer, job or seam passes to `withOrgContext` when no human acts: the empty
 * string the tenancy layer reads as "system" (F-102).
 */
export const CONSUMER_USER_ID = "";

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** The org-scoped actor of an authenticated request, or 401. */
export function actorOf(request: ContextCarrier): RouteActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  const attributes = ctx.attributes ?? {};
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    membershipId: nonEmpty(attributes.membershipId),
    roles: ctx.roles,
    locationIds: ctx.locationIds,
    sessionClass: nonEmpty(attributes.sessionClass) ?? "staff",
    actorKind: nonEmpty(attributes.actorKind) ?? "user",
    stepUpRecent: attributes.stepUpRecent === true,
  };
}

/** The actor of an authored write: {@link actorOf} plus a membership, or 401 when the session carries none. */
export function writeActorOf(request: ContextCarrier): WriteActor {
  const actor = actorOf(request);
  if (actor.membershipId === null) {
    throw new UnauthorizedError("an active membership is required to author this record");
  }
  return { ...actor, membershipId: actor.membershipId };
}

/** {@link writeActorOf} shaped for services whose `userId` is the acting membership id. */
export function membershipActorOf(request: ContextCarrier): MembershipActor {
  const { organizationId, membershipId, roles } = writeActorOf(request);
  return { organizationId, userId: membershipId, roles };
}

/** The org id of an authenticated request (user or system session), or 401. */
export function orgOf(request: ContextCarrier): string {
  const organizationId = request.context?.organizationId;
  if (!organizationId) throw new UnauthorizedError();
  return organizationId;
}

/**
 * §D13 AI-BLOCK pre-handler — refuse an `ai_*` principal before it reaches a mutating handler (403). An
 * unknown or missing kind is a user: the kind is only ever `ai_*` when M32 set it.
 */
export function rejectAiActor(message = "AI principals cannot create or modify this record (D13)") {
  return async (request: ContextCarrier): Promise<void> => {
    const kind = request.context?.attributes?.actorKind;
    if (typeof kind === "string" && kind.startsWith("ai_")) throw new ForbiddenError(message);
  };
}
