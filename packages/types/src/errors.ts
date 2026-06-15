// @wardenx/types — Standard error envelope + error class hierarchy (M1 Foundation
// §4.3; M1-T10).
//
// Every error response the platform emits uses the ONE envelope shape below, so clients
// (and every module's routes) have a single contract. Per ADR-0005 D3 these live in the
// `packages/types` leaf — NOT the banned `packages/foundation` — so any module's routes
// can throw a `WardenXError` subclass and the M1 Fastify error handler
// (apps/backend/src/bootstrap/plugins/error-handler.ts) renders it into the envelope
// without a cross-module import edge.
import { type Static, Type } from "@sinclair/typebox";

/** One field-level error detail (spec §4.3). */
export const ErrorDetail = Type.Object({
  field: Type.Optional(Type.String()),
  code: Type.String(),
  message: Type.String(),
});
export type ErrorDetailType = Static<typeof ErrorDetail>;

/** The single error-response envelope every error path renders (spec §4.3). */
export const ErrorEnvelope = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    details: Type.Optional(Type.Array(ErrorDetail)),
    correlationId: Type.String(),
    documentationUrl: Type.Optional(Type.String()),
  }),
});
export type ErrorEnvelopeType = Static<typeof ErrorEnvelope>;

/**
 * The initial error-code catalog (spec §4.3 — extended per module). The status codes are
 * the canonical HTTP mapping the error handler applies; keeping them here keeps the
 * envelope's `code` ↔ status mapping in one auditable place.
 */
export const ERROR_CODES = {
  VALIDATION_FAILED: 422,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  IDEMPOTENCY_CONFLICT: 409,
  DEGRADED: 503,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * Base application error. A route throws one of these; the M1 error handler reads
 * `code`/`statusCode`/`details` and renders the envelope. Anything that is NOT a
 * WardenXError is treated as an unexpected 500 (`INTERNAL_ERROR`) — never leaked verbatim.
 */
export class WardenXError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: ErrorDetailType[],
  ) {
    super(message);
    this.name = "WardenXError";
  }
}

export class ValidationError extends WardenXError {
  constructor(message: string, details: ErrorDetailType[]) {
    super("VALIDATION_FAILED", message, ERROR_CODES.VALIDATION_FAILED, details);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends WardenXError {
  // RLS-hidden rows return NOT_FOUND too (spec §4.3) — same response, no existence oracle.
  constructor(resource: string, id?: string) {
    super("NOT_FOUND", `${resource}${id ? ` ${id}` : ""} not found`, ERROR_CODES.NOT_FOUND);
    this.name = "NotFoundError";
  }
}

export class UnauthorizedError extends WardenXError {
  constructor(message = "Authentication required") {
    super("UNAUTHORIZED", message, ERROR_CODES.UNAUTHORIZED);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends WardenXError {
  constructor(message = "Forbidden") {
    super("FORBIDDEN", message, ERROR_CODES.FORBIDDEN);
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends WardenXError {
  constructor(message: string) {
    super("CONFLICT", message, ERROR_CODES.CONFLICT);
    this.name = "ConflictError";
  }
}

export class RateLimitedError extends WardenXError {
  constructor(message = "Too many requests") {
    super("RATE_LIMITED", message, ERROR_CODES.RATE_LIMITED);
    this.name = "RateLimitedError";
  }
}

/** Same `Idempotency-Key` replayed with a DIFFERENT body (spec §4.3 / §4.6). */
export class IdempotencyConflictError extends WardenXError {
  constructor(message = "Idempotency-Key reused with different body") {
    super("IDEMPOTENCY_CONFLICT", message, ERROR_CODES.IDEMPOTENCY_CONFLICT);
    this.name = "IdempotencyConflictError";
  }
}

/** A dependency is unavailable; the platform is in degraded mode (spec §4.3). */
export class DegradedError extends WardenXError {
  constructor(component: string, message: string) {
    super("DEGRADED", `${component}: ${message}`, ERROR_CODES.DEGRADED);
    this.name = "DegradedError";
  }
}
