// apps/backend/src/bootstrap/plugins/global-search-rate-limit.ts - composition-root wiring of the WP 2.14 limiter onto the
// M36 global-search route (ADR-0058 P2). Importer: apps/backend/src/index.ts. Input: the `RateLimitStore` index.ts builds.
//
// The limiter is a probing control, so it only counts as ACTIVE when the store is cluster-wide (the REDIS_URL/Valkey-backed
// one). The in-memory fallback is per replica (N replicas = N times the cap), so with no shared store NOTHING is wired:
// the route keeps its default fail-closed limiter (every request 503s) and the go-live checklist keeps RATE_LIMIT_INACTIVE.
// The limiter runs as a route preHandler AFTER authentication and `messaging.read`, so an anonymous or unauthorised caller
// gets the normal 401/403 and a 429/503 is only ever sent to an authenticated, permitted caller; it never sees query text
// or rows, so a refusal says nothing about hidden data.
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RateLimitStore } from "./rate-limit-store";
import { GLOBAL_SEARCH_ROUTE_RATE_LIMIT, createRouteRateLimit } from "./route-rate-limit";

export const GLOBAL_SEARCH_RATE_LIMIT_KEY_PREFIX = "m36-search";

// Structurally the M36 route's `GlobalSearchRateLimit` (bootstrap must not import a module).
export type SearchRouteRateLimit = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export interface GlobalSearchRateLimitWiring {
  readonly rateLimit?: SearchRouteRateLimit;
  readonly active: boolean;
}

export function buildGlobalSearchRateLimit(
  sharedStore: RateLimitStore | undefined,
  onStoreError?: (err: unknown) => void,
): GlobalSearchRateLimitWiring {
  if (!sharedStore) return { active: false };
  return {
    rateLimit: createRouteRateLimit({
      store: sharedStore,
      limit: GLOBAL_SEARCH_ROUTE_RATE_LIMIT,
      keyPrefix: GLOBAL_SEARCH_RATE_LIMIT_KEY_PREFIX,
      ...(onStoreError ? { onStoreError } : {}),
    }),
    active: true,
  };
}
