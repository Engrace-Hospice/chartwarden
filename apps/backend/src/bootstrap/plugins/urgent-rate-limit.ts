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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A retry of one message (same client_message_id) is bounded, but never counts against the send budgets. */
export const URGENT_RETRY_CAP = 30;

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
  const closed = (request: FastifyRequest, err: unknown): never => {
    onStoreError?.(err);
    request.log.warn(
      { keyPrefix: URGENT_RATE_LIMIT_KEY_PREFIX },
      "urgent rate-limit store unavailable",
    );
    throw new DegradedError("rate-limit", "temporarily unavailable");
  };
  const count = async (request: FastifyRequest, key: string, windowMs: number): Promise<number> => {
    try {
      const n = await store.increment(key, windowMs);
      if (!Number.isInteger(n) || n < 1) throw new Error("bad count");
      return n;
    } catch (err) {
      return closed(request, err);
    }
  };
  const refuse = (reply: FastifyReply, windowMs: number): never => {
    reply.header("Retry-After", String(Math.ceil(windowMs / 1000)));
    throw new RateLimitedError();
  };
  return async (request, reply) => {
    const { organizationId, userId } = request.context ?? {};
    if (!organizationId || !userId) throw new UnauthorizedError();
    const body = (request.body ?? {}) as {
      recipient_user_id?: unknown;
      client_message_id?: unknown;
    };
    const clientId =
      typeof body.client_message_id === "string" && UUID.test(body.client_message_id)
        ? body.client_message_id.toLowerCase()
        : null;
    const recipient =
      typeof body.recipient_user_id === "string" && UUID.test(body.recipient_user_id)
        ? body.recipient_user_id.toLowerCase()
        : null;
    // A flaky-network retry of ONE message must never lock the sender out: the second and later sightings of the same
    // client_message_id are bounded by their own cap and skip the send budgets (the core replays the original anyway).
    if (clientId) {
      const seen = await count(
        request,
        `${URGENT_RATE_LIMIT_KEY_PREFIX}:seen:${organizationId}:${userId}:${clientId}`,
        URGENT_PAIR_LIMIT.windowMs,
      );
      if (seen > URGENT_RETRY_CAP) refuse(reply, URGENT_PAIR_LIMIT.windowMs);
      if (seen > 1) return;
    }
    await base(request, reply);
    if (!recipient) return;
    const pair = await count(
      request,
      `${URGENT_RATE_LIMIT_KEY_PREFIX}:pair:${organizationId}:${userId}:${recipient}`,
      URGENT_PAIR_LIMIT.windowMs,
    );
    if (pair > URGENT_PAIR_LIMIT.max) refuse(reply, URGENT_PAIR_LIMIT.windowMs);
  };
}
