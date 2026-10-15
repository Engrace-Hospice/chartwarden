// apps/backend/src/bootstrap/plugins/urgent-rate-limit.ts - WP 4.1 (ADR-0068): the per-route limiter on the urgent clinical
// POST. Three fixed-window buckets on the same RateLimitStore the other route limiters use, ids only in the keys: per user,
// per org (createRouteRateLimit) and per (sender, recipient) pair so one person cannot flood one colleague with urgent alerts.
// Every limit FAILS CLOSED (a store outage is a 503, never an unlimited send). PROVISIONAL numbers, pending clinical-lead review.
// The pair bucket reads the recipient from the already-validated request body; a missing/odd body is left to the route schema.
import { DegradedError, RateLimitedError, UnauthorizedError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RateLimitStore } from "./rate-limit-store";
import { type RouteRateLimit, createRouteRateLimit } from "./route-rate-limit";

export const URGENT_RATE_LIMIT_KEY_PREFIX = "m36-urgent";
/** 10 per minute per sender, 100 per minute per organisation: an urgent message is rare and deliberate. */
export const URGENT_ROUTE_RATE_LIMIT: RouteRateLimit = {
  perUser: 10,
  perOrg: 100,
  windowMs: 60_000,
  failMode: "closed",
};
/** 5 per 5 minutes from one sender to one recipient. */
export const URGENT_PAIR_LIMIT = { max: 5, windowMs: 5 * 60_000 } as const;

export type UrgentRouteRateLimit = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

export function buildUrgentRateLimit(
  store: RateLimitStore,
  onStoreError?: (err: unknown) => void,
): UrgentRouteRateLimit {
  const base = createRouteRateLimit({
    store,
    limit: URGENT_ROUTE_RATE_LIMIT,
    keyPrefix: URGENT_RATE_LIMIT_KEY_PREFIX,
    ...(onStoreError ? { onStoreError } : {}),
  });
  return async (request, reply) => {
    await base(request, reply);
    const { organizationId, userId } = request.context ?? {};
    if (!organizationId || !userId) throw new UnauthorizedError();
    const recipient = (request.body as { recipient_user_id?: unknown } | null)?.recipient_user_id;
    if (typeof recipient !== "string" || recipient.length === 0) return;
    let count: number;
    try {
      count = await store.increment(
        `${URGENT_RATE_LIMIT_KEY_PREFIX}:pair:${organizationId}:${userId}:${recipient.toLowerCase()}`,
        URGENT_PAIR_LIMIT.windowMs,
      );
      if (!Number.isInteger(count) || count < 1) throw new Error("bad count");
    } catch (err) {
      onStoreError?.(err);
      request.log.warn(
        { keyPrefix: URGENT_RATE_LIMIT_KEY_PREFIX },
        "urgent rate-limit store unavailable",
      );
      throw new DegradedError("rate-limit", "temporarily unavailable");
    }
    if (count > URGENT_PAIR_LIMIT.max) {
      reply.header("Retry-After", String(Math.ceil(URGENT_PAIR_LIMIT.windowMs / 1000)));
      throw new RateLimitedError();
    }
  };
}
