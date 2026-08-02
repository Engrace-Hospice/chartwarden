// apps/backend/src/modules/28-fhir/routes/actor.ts — M28-T08 route actor binding.
//
// The org/actor binding for every M28 ADMIN route (§4.1 R23-R39) is ALWAYS server-side (the M2-assembled
// `request.context`, NEVER the body/query) — the single home for that extraction (the M32/M15/M16/M19/M20
// precedent). No handler reads an org id, an acting membership id or a step-up flag off the wire.
//
// The FHIR-spec surface (R1-R22) authenticates with a SMART bearer token, not a WardenX session, and does
// NOT go through this file — its actor is the `fhir_client`, resolved by ./bearer.ts.
import { ForbiddenError, UnauthorizedError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The org-scoped read actor for M28's admin console. */
export interface M28ReadActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string | null;
  readonly roles: readonly string[];
}

/** Extract the org-scoped read actor from `request.context` (server-assembled), or 401. */
export function actorOf(request: FastifyRequest): M28ReadActor {
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
export interface M28WriteActor extends M28ReadActor {
  readonly membershipId: string;
  /** True iff the session carries a recent (server-verified) step-up auth (M2 SESSION_POLICY). */
  readonly stepUpRecent: boolean;
}

/**
 * Extract the WRITE actor, or 401/403.
 *
 * EVERY M28 admin mutation goes through this. There is no anonymous or service-principal write path on the
 * admin surface: every write stamps an ACCOUNTABLE membership — `fhir_client.approved_by_*_membership_id`,
 * `fhir_bulk_export_job.initiated_by_membership_id`, `fhir_inbound_resource.decided_by_membership_id` — so
 * the §164.528 accounting names a person, not a system principal.
 */
export function writeActorOf(request: FastifyRequest): M28WriteActor {
  const actor = actorOf(request);
  if (actor.membershipId === null) {
    throw new ForbiddenError(
      "an M28 FHIR-gateway mutation must be attributed to an active membership; this session carries none",
    );
  }
  return {
    ...actor,
    membershipId: actor.membershipId,
    stepUpRecent: request.context?.attributes?.stepUpRecent === true,
  };
}
