// @chartwarden/shared/route-kit — the two mutation preconditions: optimistic concurrency (`If-Match`) and
// the `Idempotency-Key` header.
//
// Status contract (System Design §6.2): a missing `If-Match` is 428 IF_MATCH_REQUIRED, a malformed one 400,
// a stale one 409 STALE_VERSION ("409 — conflict (concurrent modification)"). A missing or oversized
// `Idempotency-Key` is 400; replay and conflict handling is the M1 platform middleware
// (`apps/backend/src/bootstrap/plugins/idempotency.ts`, over `claimIdempotencyKey`).
import { ChartWardenError } from "@chartwarden/types";

/** Anything carrying request headers (a FastifyRequest does). */
export interface HeaderCarrier {
  readonly headers: Readonly<Record<string, unknown>>;
}

/** 428 — the route requires the row version the caller read in `If-Match`. */
export class IfMatchRequiredError extends ChartWardenError {
  constructor() {
    super(
      "IF_MATCH_REQUIRED",
      "an If-Match header (the row version you read) is required on this route",
      428,
    );
    this.name = "IfMatchRequiredError";
  }
}

/** 409 — the row changed since the caller read it. */
export class StaleVersionError extends ChartWardenError {
  constructor(message = "the record changed since you read it; reload and try again") {
    super("STALE_VERSION", message, 409);
    this.name = "StaleVersionError";
  }
}

/** 400 — the mutation did not carry a usable `Idempotency-Key`. */
export class IdempotencyKeyRequiredError extends ChartWardenError {
  constructor() {
    super("IDEMPOTENCY_KEY_REQUIRED", "an Idempotency-Key header (1-128 chars) is required", 400);
    this.name = "IdempotencyKeyRequiredError";
  }
}

const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

function headerOf(request: HeaderCarrier, name: string): string | undefined {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value : undefined;
}

/**
 * The row version in `If-Match`. A weak prefix (`W/"3"`) and quotes are tolerated because caches and
 * `fetch` add them; absent is 428, anything that is not a non-negative integer after that is 400.
 */
export function ifMatchVersionOf(request: HeaderCarrier): number {
  const value = headerOf(request, "if-match")?.trim();
  if (!value) throw new IfMatchRequiredError();
  const cleaned = value.replace(/^W\//, "").replace(/"/g, "");
  if (!/^\d+$/.test(cleaned)) {
    throw new ChartWardenError(
      "VALIDATION_FAILED",
      "If-Match must be the integer row version you read",
      400,
    );
  }
  return Number(cleaned);
}

/** Pre-handler: refuse a request without a well-formed `If-Match` before the handler runs. */
export function requireIfMatch() {
  return async (request: HeaderCarrier): Promise<void> => {
    ifMatchVersionOf(request);
  };
}

/** Pre-handler: refuse a mutation without an `Idempotency-Key` of 1–128 chars. */
export function requireIdempotencyKey() {
  return async (request: HeaderCarrier): Promise<void> => {
    const key = headerOf(request, "idempotency-key");
    if (!key || key.length > IDEMPOTENCY_KEY_MAX_LENGTH) throw new IdempotencyKeyRequiredError();
  };
}

/** 409 STALE_VERSION unless the version the caller read is the current one. */
export function assertVersion(current: number, expected: number, message?: string): void {
  if (current !== expected) throw new StaleVersionError(message);
}
