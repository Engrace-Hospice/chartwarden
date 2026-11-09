// apps/backend/src/modules/41-billing-commercial/routes/guards.ts - the route guards M41 composes (plumbing is the route kit).
//
// Org and actor are ALWAYS the server-assembled `request.context`, never the body. Scope predicates are REUSED, not re-registered:
// `provider_entity_billing_scope` (M23) over the provider entity the request names, `caseload_or_scope` (M5 base) over the patient.
import { requireAbac, requirePermission, requireStepUp } from "@chartwarden/auth";
import { IdempotencyKeyRequiredError, type PreHandler } from "@chartwarden/shared/route-kit";
import { COMMERCIAL_BILLING_PERMISSIONS } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";

const IDEMPOTENCY_KEY_MAX = 128;

/** The `Idempotency-Key` a handler forwards to its service (the kit pre-handler has already checked it). */
export function idempotencyKeyOf(request: FastifyRequest): string {
  const raw = request.headers["idempotency-key"];
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (typeof key !== "string" || key.length === 0 || key.length > IDEMPOTENCY_KEY_MAX) {
    throw new IdempotencyKeyRequiredError();
  }
  return key;
}

type Target = Record<string, unknown>;
type TargetRequest = { readonly body?: unknown; readonly query?: unknown };

export const READ = requirePermission(COMMERCIAL_BILLING_PERMISSIONS.READ) as PreHandler;
export const WRITE = requirePermission(COMMERCIAL_BILLING_PERMISSIONS.WRITE) as PreHandler;
export const MANAGE_ENROLLMENT = requirePermission(
  COMMERCIAL_BILLING_PERMISSIONS.MANAGE_ENROLLMENT,
) as PreHandler;
/** Enrollment changes demand a fresh step-up; the operation key is the permission key. */
export const ENROLLMENT_STEP_UP = requireStepUp(
  COMMERCIAL_BILLING_PERMISSIONS.MANAGE_ENROLLMENT,
) as PreHandler;

/**
 * The ABAC target is read from the SAME source the handler reads, and only that source: a GET handler parses `request.query`, a
 * POST/PATCH handler parses `request.body`. Falling back from one to the other let a GET carry its own ids in a JSON body (which
 * Fastify parses on GET) for the scope check while the handler used different ids from the query string.
 */
export type TargetSource = "body" | "query";

const fieldFrom = (request: TargetRequest, source: TargetSource, field: string): string => {
  const bag = request[source] as Record<string, unknown> | undefined;
  const value = bag?.[field];
  return typeof value === "string" ? value : "";
};

export const PROVIDER_SCOPE = (key: string, source: TargetSource): PreHandler =>
  requireAbac(key, "provider_entity_billing_scope", {
    getTarget: (request: TargetRequest): Target => ({
      providerEntityId: fieldFrom(request, source, "providerEntityId"),
    }),
    notFoundOnDeny: true,
  }) as PreHandler;

export const PATIENT_SCOPE = (key: string, source: TargetSource): PreHandler =>
  requireAbac(key, "caseload_or_scope", {
    getTarget: (request: TargetRequest): Target => ({
      patientId: fieldFrom(request, source, "patientId"),
    }),
    notFoundOnDeny: true,
  }) as PreHandler;
