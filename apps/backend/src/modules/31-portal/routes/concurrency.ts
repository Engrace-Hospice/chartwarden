// apps/backend/src/modules/31-portal/routes/concurrency.ts — M31-T07 (ADR-0021 route-boundary policy).
//
// Two route-boundary concerns that are policy, not per-route detail (the M19/M20 routes/concurrency.ts
// precedent): every mutating portal route requires a client-supplied `Idempotency-Key` (the double-tapped
// button on a phone with one bar of signal — a caregiver attesting a dose twice), and PHI list routes
// refuse `?offset=` (offset pagination discloses a count oracle; keyset only).
import { WardenXError } from "@wardenx/types";
import type { PreHandler } from "./actor";

/** ADR-0021 — every mutating route requires a client-supplied Idempotency-Key (1–128 chars). */
export function requireIdempotencyKey(): PreHandler {
  return async (request) => {
    const raw = request.headers["idempotency-key"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== "string" || value.length < 1 || value.length > 128) {
      throw new WardenXError(
        "IDEMPOTENCY_KEY_REQUIRED",
        "an Idempotency-Key header is required",
        400,
      );
    }
  };
}

/** §4.1.1 — refuse `?offset=` on a PHI list route (offset pagination is forbidden). */
export function rejectOffsetPagination(): PreHandler {
  return async (request) => {
    const query = (request.query ?? {}) as Record<string, unknown>;
    if (query.offset !== undefined) {
      throw new WardenXError(
        "OFFSET_PAGINATION_FORBIDDEN",
        "offset pagination is not supported on PHI list routes; use ?cursor=",
        400,
      );
    }
  };
}
