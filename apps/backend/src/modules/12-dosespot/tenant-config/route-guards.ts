// apps/backend/src/modules/12-dosespot/tenant-config/route-guards.ts — the small route-layer primitives the DoseSpot tenant
// routes share: the server-assembled write actor, the `Idempotency-Key` presence guard and the optional `If-Match` version.
// M12 has no `routes/concurrency.ts` of its own; these are the same few lines M23 and M34 carry (a third copy: extract when a
// fourth appears).
import { ChartWardenError, UnauthorizedError, ValidationError } from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { ClinicActor } from "./service";

export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

/** The acting tenant admin, assembled server-side from the session (never the body); 401 without an active membership. */
export interface ClinicRequestActor extends ClinicActor {
  readonly request: {
    readonly correlationId?: string;
    readonly requestId?: string;
    readonly sourceIp?: string;
    readonly userAgent?: string;
  };
}

export function clinicActorOf(request: FastifyRequest): ClinicRequestActor {
  const ctx = request.context;
  const membershipId = ctx?.attributes?.membershipId;
  if (
    !ctx?.organizationId ||
    !ctx.userId ||
    typeof membershipId !== "string" ||
    membershipId === ""
  ) {
    throw new UnauthorizedError(
      "an active membership is required to change the DoseSpot registration",
    );
  }
  return {
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    membershipId,
    request: {
      ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
      requestId: String(request.id),
      ...(ctx.ip ? { sourceIp: ctx.ip } : {}),
      ...(ctx.userAgent ? { userAgent: ctx.userAgent } : {}),
    },
  };
}

/** The read-only org binding (a GET needs no membership). */
export function orgOf(request: FastifyRequest): string {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return ctx.organizationId;
}

/** `Idempotency-Key` presence (the 24h replay caching is the M1 global middleware; this only refuses a retry-unsafe client). */
export function requireIdempotencyKey(): PreHandler {
  return async (request) => {
    const raw = request.headers["idempotency-key"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > MAX_IDEMPOTENCY_KEY_LENGTH
    ) {
      throw new ChartWardenError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "an Idempotency-Key header is required on this route",
        400,
      );
    }
  };
}

/** The optional `If-Match` version: absent on a first save, an integer when changing an existing registration. */
export function optionalIfMatch(request: FastifyRequest): number | undefined {
  const raw = request.headers["if-match"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length === 0) return undefined;
  const unquoted = value
    .trim()
    .replace(/^W\//, "")
    .replace(/^"(.*)"$/, "$1");
  const parsed = Number.parseInt(unquoted, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== unquoted) {
    throw new ValidationError("request validation failed", [
      {
        field: "If-Match",
        code: "INVALID",
        message: "If-Match must be the registration's integer version",
      },
    ]);
  }
  return parsed;
}
