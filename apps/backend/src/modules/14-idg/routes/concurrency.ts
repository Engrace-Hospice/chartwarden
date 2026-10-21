// apps/backend/src/modules/14-idg/routes/concurrency.ts — the §4.12.2 header guards for the M14 routes that
// take `Idempotency-Key` + `If-Match` (today: the discipline-note writes).
//
//  • `requireIfMatch`        — §7.7 optimistic concurrency. The PATCH carries the row `version` it read in the
//                              `If-Match` header (bare integer or quoted ETag). Absent => 428; malformed => 400
//                              (never silently "no precondition"). The parsed version is stashed on the request;
//                              the service compares it to the current row and raises 412 STALE_VERSION on skew.
//  • `requireIdempotencyKey` — presence only (1–128 chars). Replay/body-mismatch caching is the M1 platform
//                              `applyIdempotency` middleware, mounted globally on buildServer.
//
// Pure header guards (no IO). M14 cannot import M7's copy (module boundary), so this is a local mirror of the
// M7/M22 `concurrency.ts` precedent. Both headers are registered `not-authorization` in
// scripts/check-request-header-auth.ts: a wrong value can lose a write, never win one.
import { ChartWardenError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";

type PreHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Request carrying the parsed `If-Match` version (set by {@link requireIfMatch}). */
export type WithIfMatch = FastifyRequest & { ifMatchVersion?: number };

const IF_MATCH_RE = /^"?(\d+)"?$/;

export function requireIfMatch(): PreHandler {
  return async (request) => {
    const raw = request.headers["if-match"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ChartWardenError(
        "PRECONDITION_REQUIRED",
        "an If-Match header (the row version you read) is required on this route",
        428,
      );
    }
    const m = IF_MATCH_RE.exec(value.trim());
    if (!m) {
      throw new ChartWardenError(
        "VALIDATION_FAILED",
        "If-Match must be the integer row version you read",
        400,
      );
    }
    (request as WithIfMatch).ifMatchVersion = Number.parseInt(m[1] ?? "", 10);
  };
}

export function requireIdempotencyKey(): PreHandler {
  return async (request) => {
    const raw = request.headers["idempotency-key"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string" || value.length < 1 || value.length > 128) {
      throw new ChartWardenError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "an Idempotency-Key header is required on this route",
        400,
      );
    }
  };
}

/** The `If-Match` version {@link requireIfMatch} parsed (throws if the guard was not mounted — a wiring bug). */
export function ifMatchVersionOf(request: FastifyRequest): number {
  const v = (request as WithIfMatch).ifMatchVersion;
  if (typeof v !== "number") {
    throw new ChartWardenError("PRECONDITION_REQUIRED", "If-Match was not parsed for this route", 428);
  }
  return v;
}
