// apps/backend/src/bootstrap/plugins/route-rate-limit.ts — WP 2.14 / ADR-0058 P2: a reusable
// PER-ROUTE rate limit, layered on the same `RateLimitStore` the global SD-055 limiter reads
// through (`security.ts`). The global limiter is one org-wide 600/min bucket that FAILS OPEN; this
// is opt-in per route (`{ preHandler: [createRouteRateLimit(...)] }`), keys the authenticated user
// and the org as two independent buckets, and can FAIL CLOSED for routes where the limiter is a
// probing control rather than only an availability one (the M36 global-search oracle).
//
// Nothing is registered by default: a route that does not name this preHandler is untouched.
//
// Key hygiene: keys are `<prefix>:user:<orgId>:<userId>` and `<prefix>:org:<orgId>` — ids only, never
// PHI or query text. Expiry is the store's job (Valkey PEXPIRE on the first hit of a window, see
// `rate-limit-store.ts`), so cardinality is bounded by active callers per window and no
// application clock participates in the window (clock skew between replicas is irrelevant).
import { DegradedError, RateLimitedError, UnauthorizedError } from "@chartwarden/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RateLimitStore } from "./rate-limit-store";

export interface RouteRateLimit {
  readonly perUser: number;
  readonly perOrg: number;
  readonly windowMs: number;
  /** `closed`: a store outage refuses with 503 (never silently allows). `open`: allow and log. */
  readonly failMode: "closed" | "open";
}

/** ADR-0058 P2 (Decided 2026-10-13): 30/min/user (one query per 2 s), 300/min/org, fail-closed. */
export const GLOBAL_SEARCH_ROUTE_RATE_LIMIT: RouteRateLimit = {
  perUser: 30,
  perOrg: 300,
  windowMs: 60_000,
  failMode: "closed",
};

/** M14 `POST /idg/meetings/:id/packets/build`: an availability control (a build is heavy), so fail-open. */
export const M14_PACKET_BUILD_ROUTE_RATE_LIMIT: RouteRateLimit = {
  perUser: 10,
  perOrg: 60,
  windowMs: 60_000,
  failMode: "open",
};

export interface RouteRateLimitOptions {
  readonly store: RateLimitStore;
  readonly limit: RouteRateLimit;
  /** Domain-separates this route's buckets from every other limiter's, e.g. `search`. */
  readonly keyPrefix: string;
  /** Called (with the error) when the store throws, in either fail mode. */
  readonly onStoreError?: (err: unknown) => void;
}

class StoreUnavailable extends Error {}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`route rate limit: ${name} must be a positive integer, got ${value}`);
  }
}

export function createRouteRateLimit(
  opts: RouteRateLimitOptions,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const { store, limit, keyPrefix } = opts;
  assertPositiveInteger("perUser", limit.perUser);
  assertPositiveInteger("perOrg", limit.perOrg);
  assertPositiveInteger("windowMs", limit.windowMs);
  if (!keyPrefix) throw new Error("route rate limit: keyPrefix must be non-empty");
  if (limit.failMode !== "open" && limit.failMode !== "closed") {
    throw new Error(`route rate limit: failMode must be "open" or "closed"`);
  }
  const retryAfter = String(Math.ceil(limit.windowMs / 1000));

  async function count(key: string): Promise<number> {
    let n: number;
    try {
      n = await store.increment(key, limit.windowMs);
    } catch (err) {
      throw new StoreUnavailable("store threw", { cause: err });
    }
    if (!Number.isInteger(n) || n < 1)
      throw new StoreUnavailable("store returned a non-numeric count");
    return n;
  }

  return async (request, reply) => {
    const orgId = request.context?.organizationId;
    const userId = request.context?.userId;
    // Out of scope for unauthenticated callers: refuse rather than leave the route unlimited.
    if (!orgId || !userId) throw new UnauthorizedError();

    try {
      // User first: a request refused for the user cap must not drain the shared org budget.
      const userCount = await count(`${keyPrefix}:user:${orgId}:${userId}`);
      if (userCount > limit.perUser) return refuse(reply, retryAfter);
      const orgCount = await count(`${keyPrefix}:org:${orgId}`);
      if (orgCount > limit.perOrg) return refuse(reply, retryAfter);
    } catch (err) {
      if (!(err instanceof StoreUnavailable)) throw err;
      opts.onStoreError?.(err.cause ?? err);
      request.log.warn(
        { err: err.cause ?? err, keyPrefix, failMode: limit.failMode },
        "route rate-limit store unavailable",
      );
      if (limit.failMode === "open") return;
      throw new DegradedError("rate-limit", "temporarily unavailable");
    }
  };
}

function refuse(reply: FastifyReply, retryAfter: string): never {
  // ponytail: fixed window, so up to 2x the cap can land across a window boundary; sliding window if that matters.
  // Fixed-window store exposes no remaining TTL: the full window is an honest upper bound.
  reply.header("Retry-After", retryAfter);
  throw new RateLimitedError();
}
