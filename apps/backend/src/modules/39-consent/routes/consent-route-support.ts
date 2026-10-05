// apps/backend/src/modules/39-consent/routes/consent-route-support.ts — the small shared pieces of the M39
// route inventory (permission / step-up guard handles, server-derived actor + command provenance, error
// mapping), split out of consent-routes.ts so that file stays under the maintainability ceiling. A pure
// move: no behaviour differs from when these lived inline.
import { requirePermission, requireStepUp } from "@wardenx/auth";
import { ConsentRouteError } from "@wardenx/consent";
import { UnauthorizedError, WardenXError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ConsentStaffActor } from "../access-scope";
import { accessActorOf } from "./consent-guards";

/** A @wardenx/auth GuardHandler wrapped as a Fastify preHandler (structurally assignable). */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** The authenticated actor the service layer scopes against (server-derived, never the body). */
export function scopedActorOf(request: FastifyRequest): ConsentStaffActor {
  const actor = accessActorOf(request);
  if (!actor) throw new UnauthorizedError();
  return actor;
}

export function actorOf(request: FastifyRequest): { organizationId: string; userId: string } {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

/** Server-authenticated command provenance. Body fields can never forge these identifiers. */
export function commandContextOf(request: FastifyRequest): {
  stepUpSessionId?: string;
  membershipId?: string;
} {
  const attrs = request.context?.attributes ?? {};
  return {
    ...(typeof attrs.sessionId === "string" ? { stepUpSessionId: attrs.sessionId } : {}),
    ...(typeof attrs.membershipId === "string" ? { membershipId: attrs.membershipId } : {}),
  };
}

export const READ_CATALOG = requirePermission("consent.read_catalog") as PreHandler;
export const READ = requirePermission("consent.read") as PreHandler;
export const READ_HISTORY = requirePermission("consent.read_history") as PreHandler;
export const READ_EVAL_AUDIT = requirePermission("consent.read_eval_audit") as PreHandler;
export const AUTHOR = requirePermission("consent.author") as PreHandler;
export const SIGN = requirePermission("consent.sign") as PreHandler;
export const REVOKE = requirePermission("consent.revoke") as PreHandler;
export const MANAGE_OVERLAY = requirePermission("consent.manage_overlay") as PreHandler;
export const ADMIN_RE_RENDER = requirePermission("consent.admin_re_render") as PreHandler;
export const CASCADE_ADMIN = requirePermission("consent.cascade_admin") as PreHandler;
export const BEREAVEMENT_AUTHOR = requirePermission(
  "consent.bereavement_outreach_author",
) as PreHandler;
export const SIGN_STEP_UP = requireStepUp("consent.sign") as PreHandler;
export const REVOKE_STEP_UP = requireStepUp("consent.revoke") as PreHandler;
export const AUTHOR_STEP_UP = requireStepUp("consent.author") as PreHandler;
export const OVERLAY_STEP_UP = requireStepUp("consent.manage_overlay") as PreHandler;
export const RE_RENDER_STEP_UP = requireStepUp("consent.admin_re_render") as PreHandler;
export const CASCADE_STEP_UP = requireStepUp("consent.cascade_admin") as PreHandler;
export const BEREAVEMENT_STEP_UP = requireStepUp(
  "consent.bereavement_outreach_author",
) as PreHandler;

/** The wall clock every lifecycle write stamps with (one read per request, so a single handler's
 *  transitions share an instant — never two clocks inside one state change). */
export const nowIso = (): string => new Date().toISOString();

export function mapError(e: unknown): never {
  if (e instanceof ConsentRouteError) {
    if (e.code === "not_found") throw new WardenXError("NOT_FOUND", e.message, 404);
    if (e.code === "validation") throw new WardenXError("VALIDATION_FAILED", e.message, 422);
    throw new WardenXError("CONFLICT", e.message, 409);
  }
  throw e;
}
