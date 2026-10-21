// apps/backend/src/modules/23-billing-medicare/routes/concurrency.ts — M23 (§4.1.1 Idempotency-Key +
// §2.5 If-Match + cursor pagination). The M27 cost-report/routes/concurrency.ts precedent.
//
// Three route-layer concurrency primitives the M23 routes share:
//   - the opaque keyset-cursor envelope ({@link CursorPage}) every LIST route returns; the cursor encodes
//     `(createdAt DESC, id DESC)` and the @wardenx/billing repos mint/decode it (this file re-exports the
//     package codec so routes + services speak the same opaque cursor).
//   - {@link requireIdempotencyKey} — the mutating-route `Idempotency-Key` presence guard (§4.1.1).
//   - {@link requireIfMatch} — the §2.5 optimistic-concurrency `If-Match` presence + parse guard; a stale
//     version is surfaced as 412 by the write service (VERSION_CONFLICT), this guard only enforces that a
//     mutation of a versioned root CARRIES the header so a lost-update is impossible.
import { ChartWardenError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";
// Re-export the package cursor codec + page envelope so the route + service layers share one opaque cursor.
export {
  type CursorKeyset,
  type CursorPage,
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  encodeCursor,
  MAX_PAGE_SIZE,
  pageSizeOf,
} from "@wardenx/billing";

/** A @wardenx/auth GuardHandler-shaped Fastify pre-handler. */
export type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** 400 IDEMPOTENCY_KEY_REQUIRED — a mutating route did not carry the required `Idempotency-Key` header. */
export class IdempotencyKeyRequiredError extends ChartWardenError {
  constructor() {
    super("IDEMPOTENCY_KEY_REQUIRED", "an Idempotency-Key header is required on this route", 400);
    this.name = "IdempotencyKeyRequiredError";
  }
}

/** 428 IF_MATCH_REQUIRED — a versioned-root mutation did not carry the required `If-Match` header (§2.5). */
export class IfMatchRequiredError extends ChartWardenError {
  constructor() {
    super("IF_MATCH_REQUIRED", "an If-Match header is required on this route", 428);
    this.name = "IfMatchRequiredError";
  }
}

/**
 * §4.1.1 — refuse a mutating request that does not carry an `Idempotency-Key` header (1–128 chars). Every
 * M23 non-idempotent POST/PUT/PATCH/DELETE is idempotency-required; the actual 24h replay / body-mismatch
 * caching is the M1 platform `applyIdempotency` middleware (mounted globally on buildServer). This pure
 * header guard only enforces PRESENCE so a retry-unsafe client is refused up front (the M27
 * `requireIdempotencyKey` precedent — no IO, no cross-module import).
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

/**
 * §2.5 — parse the `If-Match` header on a versioned-root mutation into the expected `version` integer, or
 * refuse with 428 when it is absent/malformed. The header carries the integer optimistic-concurrency
 * version the client last read; the write service compares it under the row lock and surfaces a 412
 * VERSION_CONFLICT on a stale value (the repo `VersionedUpdateResult`). Quoted ETags (`"7"`) are accepted.
 */
export function parseIfMatch(request: FastifyRequest): number {
  const raw = request.headers["if-match"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") throw new IfMatchRequiredError();
  const unquoted = value
    .trim()
    .replace(/^"(.*)"$/, "$1")
    .replace(/^W\//, "");
  const parsed = Number.parseInt(unquoted, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== unquoted) {
    throw new ChartWardenError("VALIDATION_FAILED", "the If-Match header is malformed", 400);
  }
  return parsed;
}

/** §2.5 presence guard — refuse a versioned-root mutation that does not carry an `If-Match` header. */
export function requireIfMatch(): PreHandler {
  return async (request) => {
    parseIfMatch(request);
  };
}
