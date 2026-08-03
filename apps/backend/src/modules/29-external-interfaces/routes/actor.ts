// apps/backend/src/modules/29-external-interfaces/routes/actor.ts — M29-T08 route actor binding.
//
// The org/actor binding for every M29 route (§4.1 operator surface + §4.2 clinician surface) is ALWAYS
// server-side (the M2-assembled `request.context`, NEVER the body/query) — the single home for that
// extraction (the M28/M32/M20 precedent). No handler reads an org id, an acting membership id or a step-up
// flag off the wire.
import { ForbiddenError, UnauthorizedError } from "@wardenx/types";
import type { FastifyRequest } from "fastify";

/** The org-scoped read actor for M29's surfaces. */
export interface M29ReadActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string | null;
  readonly roles: readonly string[];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Extract the org-scoped read actor from `request.context` (server-assembled), or 401. */
export function actorOf(request: FastifyRequest): M29ReadActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    membershipId: str(ctx.attributes?.membershipId),
    roles: ctx.roles,
  };
}

/** The WRITE actor — the read actor with a guaranteed membership plus the step-up flag. */
export interface M29WriteActor extends M29ReadActor {
  readonly membershipId: string;
  /** True iff the session carries a recent (server-verified) step-up auth (M2 SESSION_POLICY, D18). */
  readonly stepUpRecent: boolean;
}

/**
 * Extract the WRITE actor, or 401/403.
 *
 * EVERY M29 mutation goes through this. There is no anonymous or service-principal write path on the admin
 * surface: every write stamps an ACCOUNTABLE membership — `external_feed.proposed_by_membership_id`,
 * `hl7_inbound_proposal.decided_by_membership_id`, `nppes_sync_run.triggered_by_membership_id` — so the
 * §164.528 accounting names a person, not a system principal.
 */
export function writeActorOf(request: FastifyRequest): M29WriteActor {
  const actor = actorOf(request);
  if (actor.membershipId === null) {
    throw new ForbiddenError(
      "an M29 external-interfaces mutation must be attributed to an active membership; this session carries none",
    );
  }
  return {
    ...actor,
    membershipId: actor.membershipId,
    stepUpRecent: request.context?.attributes?.stepUpRecent === true,
  };
}
