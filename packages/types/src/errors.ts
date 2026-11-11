// @chartwarden/types — Standard error envelope + error class hierarchy (M1 Foundation
// §4.3; M1-T10).
//
// Every error response the platform emits uses the ONE envelope shape below, so clients
// (and every module's routes) have a single contract. Per ADR-0005 D3 these live in the
// `packages/types` leaf — NOT the banned `packages/foundation` — so any module's routes
// can throw a `ChartWardenError` subclass and the M1 Fastify error handler
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
  CSRF_VALIDATION_FAILED: 403,
  /**
   * The session is authenticated and authorized, and is not FRESH enough for this operation
   * (M3 §4.2.1 `step_up_recent`). 403 like FORBIDDEN — the status is a statement about this
   * request, and this request IS refused — but a DIFFERENT code, because the two refusals have
   * opposite remedies: FORBIDDEN means stop, STEP_UP_REQUIRED means re-authenticate and retry.
   */
  STEP_UP_REQUIRED: 403,
  IDEMPOTENCY_CONFLICT: 409,
  /** A record for the key was written under a server key that has since changed (a rotated secret): not a different body. */
  IDEMPOTENCY_KEY_STALE: 409,
  /**
   * A duplicate arrived while the FIRST request with the same `Idempotency-Key` is still running. 409 like CONFLICT, but a
   * different code because the remedy is the opposite: a business CONFLICT means this request is refused, while
   * IDEMPOTENCY_IN_FLIGHT means "your first request is still running, retry with the SAME key". A client that renews its key
   * on a plain 409 would start a second write while the first is still in progress.
   */
  IDEMPOTENCY_IN_FLIGHT: 409,
  /**
   * The first request with this `Idempotency-Key` claimed it and never finished (its process died after the claim, or the
   * bookkeeping that records its outcome failed), and has stayed pending past IDEMPOTENCY_PENDING_MAX_AGE_MS. 409 like the
   * others, but the remedy is different from IDEMPOTENCY_IN_FLIGHT: the outcome of the first request is UNKNOWN (it may have
   * been applied), so the client must not retry with this key and must not assume failure either: read the resource, and use a
   * new key only if the change is not there. The row is never reclaimed or re-run.
   */
  IDEMPOTENCY_KEY_STUCK: 409,
  DEGRADED: 503,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * Base application error. A route throws one of these; the M1 error handler reads
 * `code`/`statusCode`/`details` and renders the envelope. Anything that is NOT a
 * ChartWardenError is treated as an unexpected 500 (`INTERNAL_ERROR`) — never leaked verbatim.
 */
export class ChartWardenError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly details?: ErrorDetailType[],
  ) {
    super(message);
    this.name = "ChartWardenError";
  }
}

export class ValidationError extends ChartWardenError {
  constructor(message: string, details: ErrorDetailType[]) {
    super("VALIDATION_FAILED", message, ERROR_CODES.VALIDATION_FAILED, details);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends ChartWardenError {
  // RLS-hidden rows return NOT_FOUND too (spec §4.3) — same response, no existence oracle.
  constructor(resource: string, id?: string) {
    super("NOT_FOUND", `${resource}${id ? ` ${id}` : ""} not found`, ERROR_CODES.NOT_FOUND);
    this.name = "NotFoundError";
  }
}

export class UnauthorizedError extends ChartWardenError {
  constructor(message = "Authentication required") {
    super("UNAUTHORIZED", message, ERROR_CODES.UNAUTHORIZED);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends ChartWardenError {
  constructor(message = "Forbidden") {
    super("FORBIDDEN", message, ERROR_CODES.FORBIDDEN);
    this.name = "ForbiddenError";
  }
}

/**
 * A step-up (re-authentication) refusal — `requireStepUp`'s denial, distinguishable from every other
 * 403 (F-084).
 *
 * WHY THIS EXISTS. `requireStepUp` is a thin `requireAbac` over `step_up_recent`, so its denial was a
 * plain `ForbiddenError` and reached the browser as `FORBIDDEN` — indistinguishable from "your role
 * does not grant this". FIVE modules had already written the branch that needs to tell them apart and
 * shipped it dead: M6, M8, M23, M24 and M39 each carry an `authFailureRedirect` that routes a
 * `STEP_UP_REQUIRED` code to the `/step-up` screen, and M8's own header says why it never fires —
 * "packages/auth's requireAbac/requireStepUp still don't emit a distinguishable STEP_UP_REQUIRED error
 * code on denial (a pre-existing, cross-module gap — every requireStepUp caller, not just M8)".
 *
 * The cost of the generic code is not cosmetic. A clinician who must re-authenticate to sign a visit
 * note was told "You do not have permission for this action" — a statement about their ROLE, which is
 * false, and which no amount of retrying fixes. The remedy was one screen away and nothing pointed at
 * it. Until the step-up ceremony itself could be completed (F-081) pointing there would have been a
 * loop, which is the honest reason this waited.
 *
 * Still 403, deliberately: the status describes THIS request, and this request is refused. Changing it
 * to 412 would rewrite the declared responses of 138 route guards to say something about a
 * precondition header they do not have.
 */
export class StepUpRequiredError extends ChartWardenError {
  constructor(message = "A recent re-authentication is required for this operation") {
    super("STEP_UP_REQUIRED", message, ERROR_CODES.STEP_UP_REQUIRED);
    this.name = "StepUpRequiredError";
  }
}

export class ConflictError extends ChartWardenError {
  constructor(message: string) {
    super("CONFLICT", message, ERROR_CODES.CONFLICT);
    this.name = "ConflictError";
  }
}

export class RateLimitedError extends ChartWardenError {
  constructor(message = "Too many requests") {
    super("RATE_LIMITED", message, ERROR_CODES.RATE_LIMITED);
    this.name = "RateLimitedError";
  }
}

/** Double-submit CSRF cookie/header mismatch or missing on a cookie-authenticated mutation (WX-PR-017). */
export class CsrfValidationError extends ChartWardenError {
  constructor(message = "CSRF validation failed") {
    super("CSRF_VALIDATION_FAILED", message, ERROR_CODES.CSRF_VALIDATION_FAILED);
    this.name = "CsrfValidationError";
  }
}

/** Same `Idempotency-Key` replayed with a DIFFERENT body (spec §4.3 / §4.6). */
export class IdempotencyConflictError extends ChartWardenError {
  constructor(message = "Idempotency-Key reused with different body") {
    super("IDEMPOTENCY_CONFLICT", message, ERROR_CODES.IDEMPOTENCY_CONFLICT);
    this.name = "IdempotencyConflictError";
  }
}

/**
 * An `Idempotency-Key` whose record was written under a server key that has since been rotated: the request body may be identical, so it
 * is not a conflict, and the first request may or may not have taken effect, so it is not replayed or re-run either.
 */
export class IdempotencyKeyStaleError extends ChartWardenError {
  constructor(
    message = "This Idempotency-Key was recorded before the server's idempotency key changed, so it cannot be matched to the request it was first used for. Check whether that request took effect, then retry with a new Idempotency-Key.",
  ) {
    super("IDEMPOTENCY_KEY_STALE", message, ERROR_CODES.IDEMPOTENCY_KEY_STALE);
    this.name = "IdempotencyKeyStaleError";
  }
}

/** A dependency is unavailable; the platform is in degraded mode (spec §4.3). */
export class DegradedError extends ChartWardenError {
  constructor(component: string, message: string) {
    super("DEGRADED", `${component}: ${message}`, ERROR_CODES.DEGRADED);
    this.name = "DegradedError";
  }
}
