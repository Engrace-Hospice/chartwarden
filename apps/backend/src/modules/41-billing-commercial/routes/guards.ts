// apps/backend/src/modules/41-billing-commercial/routes/guards.ts - actor binding and the route guards M41 composes.
//
// Org and actor are ALWAYS the server-assembled `request.context`, never the body. Scope predicates are REUSED, not re-registered:
// `provider_entity_billing_scope` (M23) over the provider entity the request names, `caseload_or_scope` (M5 base) over the patient.
import { requireAbac, requirePermission, requireStepUp } from "@chartwarden/auth";
import {
  COMMERCIAL_BILLING_PERMISSIONS,
  ChartWardenError,
  ForbiddenError,
  UnauthorizedError,
} from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";

export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface CommercialActor {
  readonly organizationId: string;
  readonly userId: string;
}

export function actorOf(request: FastifyRequest): CommercialActor {
  const ctx = request.context;
  if (!ctx?.organizationId || !ctx.userId) throw new UnauthorizedError();
  return { organizationId: ctx.organizationId, userId: ctx.userId };
}

/** An AI principal cannot create or change billing records (the M23 D13 rule, applied to M41). */
export const REJECT_AI_ACTOR: PreHandler = async (request) => {
  const kind = request.context?.attributes?.actorKind;
  if (typeof kind === "string" && kind.startsWith("ai_")) {
    throw new ForbiddenError("AI principals cannot create or modify billing records");
  }
};

const IDEMPOTENCY_KEY_MAX = 128;

function headerKey(request: FastifyRequest): string | undefined {
  const raw = request.headers["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length >= 1 && value.length <= IDEMPOTENCY_KEY_MAX
    ? value
    : undefined;
}

/** 400 IDEMPOTENCY_KEY_REQUIRED unless the request carries a 1..128 char `Idempotency-Key` (the M1 middleware does the replay). */
export const REQUIRE_IDEMPOTENCY_KEY: PreHandler = async (request) => {
  if (headerKey(request) === undefined) {
    throw new ChartWardenError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "an Idempotency-Key header is required on this route",
      400,
    );
  }
};

export function idempotencyKeyOf(request: FastifyRequest): string {
  const key = headerKey(request);
  if (key === undefined) {
    throw new ChartWardenError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "an Idempotency-Key header is required on this route",
      400,
    );
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

const fromBodyOrQuery = (request: TargetRequest, field: string): string => {
  const body = request.body as Record<string, unknown> | undefined;
  const query = request.query as Record<string, unknown> | undefined;
  const value = body?.[field] ?? query?.[field];
  return typeof value === "string" ? value : "";
};

export const targetProvider = (request: TargetRequest): Target => ({
  providerEntityId: fromBodyOrQuery(request, "providerEntityId"),
});
export const targetPatient = (request: TargetRequest): Target => ({
  patientId: fromBodyOrQuery(request, "patientId"),
});

export const PROVIDER_SCOPE = (key: string): PreHandler =>
  requireAbac(key, "provider_entity_billing_scope", {
    getTarget: targetProvider,
    notFoundOnDeny: true,
  }) as PreHandler;

export const PATIENT_SCOPE = (key: string): PreHandler =>
  requireAbac(key, "caseload_or_scope", {
    getTarget: targetPatient,
    notFoundOnDeny: true,
  }) as PreHandler;
