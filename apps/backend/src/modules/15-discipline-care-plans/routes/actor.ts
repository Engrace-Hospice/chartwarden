// apps/backend/src/modules/15-discipline-care-plans/routes/actor.ts — M15-T06 route actor binding.
//
// The org/actor binding for every M15 route is ALWAYS server-side (the M2-assembled `request.context`,
// NEVER the body/query) — the single home for that extraction (the M23/M24/M26 routes/actor.ts precedent).
// No handler reads an org id, an acting membership id, a session class or a step-up flag off the wire.
// Every authored row (a goal, an intervention, an assessment, a supervisory attestation, a volunteer
// assignment, a compliance gate, an hour entry) is stamped with the server-assembled membership id — the
// §8.6 (S) spoofing control: a caller cannot attest as another RN by putting their id in the body.
import { ForbiddenError, UnauthorizedError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The READ-route actor: org + user + roles + the session facts the §7.8/§7.9 disclosure gates read. */
export interface M15ReadActor {
  readonly organizationId: string;
  readonly userId: string;
  /** The actor's ACTIVE M2 membership (null when the session carries none — write paths reject). */
  readonly membershipId: string | null;
  readonly roles: readonly string[];
  /** M2 session class (`staff` unless a portal/collaborator/auditor session) — §7.9 gating input. */
  readonly sessionClass: string;
  readonly locationIds: readonly string[];
  /**
   * The SYSTEM-ACTOR marker — the one place it is defined. `"system"` exempts a caller from the write
   * service's caseload gate (a worker / outbox consumer / seam acting for the platform has no caseload).
   * It is NEVER derived from a request: {@link actorOf} / {@link writeActorOf} leave it unset, so only
   * server-side code that calls {@link systemM15Actor} can mint one. Absent ⇒ a human actor, gated.
   */
  readonly kind?: "system";
}

const str = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/** Extract the org-scoped read actor from `request.context` (server-assembled), or 401. */
export function actorOf(request: FastifyRequest): M15ReadActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    membershipId: str(ctx.attributes?.membershipId),
    roles: ctx.roles,
    sessionClass: str(ctx.attributes?.sessionClass) ?? "staff",
    locationIds: ctx.locationIds,
  };
}

/**
 * The MUTATING-route actor: the read actor PLUS the server-verified recent step-up flag
 * (`context.attributes.stepUpRecent`, §4.1 "session (step-up)" on the sign/amend routes). An authored M15
 * row is always attributed to a real membership, so a session without one cannot write.
 */
export interface M15WriteActor extends M15ReadActor {
  readonly membershipId: string;
  /** True iff the session carries a recent (server-verified) step-up auth. */
  readonly stepUpRecent: boolean;
}

/** Extract the write actor (org + user + membership + roles + step-up) from `request.context`, or 401/403. */
export function writeActorOf(request: FastifyRequest): M15WriteActor {
  const actor = actorOf(request);
  if (actor.membershipId === null) {
    throw new ForbiddenError(
      "an M15 write must be attributed to an active membership; this session carries none",
    );
  }
  return {
    ...actor,
    membershipId: actor.membershipId,
    stepUpRecent: request.context?.attributes?.stepUpRecent === true,
  };
}

/**
 * The §4.1 `/internal/...` seam routes (25–28) are SYSTEM-principal only. The permission keys are never
 * granted to a role template, and this guard is the second lock: a human session (any session whose actor
 * kind is not a system principal) is refused before the handler runs, so a leaked grant cannot turn the
 * seam surface into an un-caseloaded PHI read path.
 */
export function requireSystemPrincipal(): PreHandler {
  return async (request) => {
    const kind = request.context?.attributes?.actorKind;
    if (typeof kind !== "string" || !kind.startsWith("system")) {
      throw new ForbiddenError("this seam route is reachable by system principals only (§4.1)");
    }
  };
}

/**
 * Mint the explicit system actor for non-request callers (workers, consumers, live-suite fixtures that
 * drive the write service directly). It carries no roles and no locations — it is exempt from the caseload
 * gate by `kind`, not by an org-wide role — and must name the org plus the user / membership the authored
 * rows are attributed to. Never call this from a route handler.
 */
export function systemM15Actor(
  organizationId: string,
  attribution: { readonly userId: string; readonly membershipId: string },
): M15WriteActor {
  return {
    kind: "system",
    organizationId,
    userId: attribution.userId,
    membershipId: attribution.membershipId,
    roles: [],
    sessionClass: "staff",
    locationIds: [],
    stepUpRecent: false,
  };
}
