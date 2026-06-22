// apps/backend/src/modules/07-care-plan/routes/concurrency.ts — M7-T05 (§4.1.1, §7.7).
//
// The two PATCH-route pre-handlers M7 layers on top of the REAL Authorization Contract:
//
//  • `requireIfMatch`        — §7.7 optimistic concurrency. The PATCH carries the row `version` it read
//                              in the `If-Match` header (an ETag). Absence is a 428 PRECONDITION_REQUIRED;
//                              a non-integer is a 400. The parsed version is stashed on the request for
//                              the handler, which passes it to the service where `checkOptimisticConcurrency`
//                              compares it against the current row version (→ 412 STALE_VERSION on skew).
//  • `requireIdempotencyKey` — §4.1.1 (M07-F09). Every M7 PATCH MUST carry an `Idempotency-Key` header
//                              (400 if absent). The actual replay/body-mismatch caching is done by the
//                              M1 platform `applyIdempotency` middleware (bootstrap/plugins/idempotency.ts)
//                              which is mounted globally on buildServer — this pre-handler only enforces
//                              the header's PRESENCE so a retry-unsafe client request is refused up front.
//
// Both are pure header guards (no IO, no cross-module import). Mirrors the M6 routes precedent of
// gating state-change routes server-side; the version never comes from the body for a PATCH.
import { WardenXError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";

/** A @wardenx/auth GuardHandler-shaped Fastify pre-handler. */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Request carrying the parsed `If-Match` version the PATCH handler reads (set by {@link requireIfMatch}). */
export type WithIfMatch = FastifyRequest & { ifMatchVersion?: number };

/** 428 PRECONDITION_REQUIRED — the PATCH did not carry the required `If-Match` header (§7.7). */
export class IfMatchRequiredError extends WardenXError {
  constructor() {
    super("PRECONDITION_REQUIRED", "an If-Match header (the row version you read) is required on this route", 428);
    this.name = "IfMatchRequiredError";
  }
}

/** 400 IDEMPOTENCY_KEY_REQUIRED — the PATCH did not carry the required `Idempotency-Key` header (§4.1.1). */
export class IdempotencyKeyRequiredError extends WardenXError {
  constructor() {
    super("IDEMPOTENCY_KEY_REQUIRED", "an Idempotency-Key header is required on this route", 400);
    this.name = "IdempotencyKeyRequiredError";
  }
}

const IF_MATCH_RE = /^"?(\d+)"?$/; // bare integer or quoted ETag form (`"3"`)

/**
 * §7.7 — require + parse the `If-Match` header into `request.ifMatchVersion`. The handler hands that to
 * the service, which raises 412 STALE_VERSION when it no longer matches the current row version. A
 * missing header is a 428; a malformed one is a 400 (never silently treated as "no precondition").
 */
export function requireIfMatch(): PreHandler {
  return async (request) => {
    const raw = request.headers["if-match"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string" || value.trim().length === 0) throw new IfMatchRequiredError();
    const m = IF_MATCH_RE.exec(value.trim());
    if (!m) {
      throw new WardenXError("VALIDATION_FAILED", "If-Match must be the integer row version you read", 400);
    }
    (request as WithIfMatch).ifMatchVersion = Number.parseInt(m[1] ?? "", 10);
  };
}

/**
 * §4.1.1 (M07-F09) — refuse a PATCH that does not carry an `Idempotency-Key`. The M1 platform middleware
 * does the replay/body-mismatch caching; this only enforces presence (1–128 printable chars per spec).
 */
export function requireIdempotencyKey(): PreHandler {
  return async (request) => {
    const raw = request.headers["idempotency-key"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string" || value.length < 1 || value.length > 128) {
      throw new IdempotencyKeyRequiredError();
    }
  };
}

/** Read the parsed `If-Match` version off the request (the {@link requireIfMatch} guard ran first). */
export function ifMatchVersionOf(request: FastifyRequest): number {
  const v = (request as WithIfMatch).ifMatchVersion;
  if (typeof v !== "number") throw new IfMatchRequiredError(); // defensive — guard ordering invariant
  return v;
}
