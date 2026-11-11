// apps/backend/src/modules/12-dosespot/tenant-config/route-guards.ts — the acting admin of the DoseSpot tenant routes: the route
// kit's write actor (401 without a session; 403 for a signed-in session with no active membership — the web shell maps any 401 to
// /expired, so that case must not be one) plus the request envelope the audit rows carry. The `Idempotency-Key` guard, the optional
// `If-Match` version, the org binding and `PreHandler` are the kit's (`@chartwarden/shared/route-kit`), not copies.
import { writeActorOf } from "@chartwarden/shared/route-kit";
import type { FastifyRequest } from "fastify";
import type { ClinicActor } from "./service";

/** The acting tenant admin, assembled server-side from the session (never the body). */
export interface ClinicRequestActor extends ClinicActor {
  readonly request: {
    readonly correlationId?: string;
    readonly requestId?: string;
    readonly sourceIp?: string;
    readonly userAgent?: string;
  };
}

export function clinicActorOf(request: FastifyRequest): ClinicRequestActor {
  const { organizationId, userId, membershipId } = writeActorOf(request);
  const ctx = request.context;
  return {
    organizationId,
    userId,
    membershipId,
    lane: "tenant",
    request: {
      ...(ctx?.correlationId ? { correlationId: ctx.correlationId } : {}),
      requestId: String(request.id),
      ...(ctx?.ip ? { sourceIp: ctx.ip } : {}),
      ...(ctx?.userAgent ? { userAgent: ctx.userAgent } : {}),
    },
  };
}
