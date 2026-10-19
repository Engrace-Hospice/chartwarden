// apps/backend/src/bootstrap/plugins/ack-rate-limit.ts - WP 4.2 (ADR-0069): the limiter on the two acknowledgment-request routes that
// NOTIFY somebody (create and reassign). Three fixed-window buckets on the shared RateLimitStore, ids only in the keys: per user and
// per org (createRouteRateLimit) and per (actor, named colleague) pair, so one account cannot bury a colleague in requests. Every
// bucket FAILS CLOSED (a store outage is a 503, never an unlimited request). There is NO replay exemption: a repeat is cheap and a
// refused request must still pay. PROVISIONAL numbers, pending the clinical lead. Acknowledge and resolve notify nobody and are
// not limited.
import { DegradedError, RateLimitedError, UnauthorizedError } from "@wardenx/types";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { RateLimitStore } from "./rate-limit-store";
import { type RouteRateLimit, createRouteRateLimit } from "./route-rate-limit";

export const ACK_RATE_LIMIT_KEY_PREFIX = "m36-ack";
export const ACK_PICKER_RATE_LIMIT_KEY_PREFIX = "m36-ack-picker";
/** 20 per minute per user, 200 per minute per organisation. */
export const ACK_ROUTE_RATE_LIMIT: RouteRateLimit = {
  perUser: 20,
  perOrg: 200,
  windowMs: 60_000,
  failMode: "closed",
};
/** 5 per 5 minutes from one actor naming one colleague. */
export const ACK_PAIR_LIMIT = { max: 5, windowMs: 5 * 60_000 } as const;

export type AckRouteRateLimit = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function buildAckRateLimit(
  store: RateLimitStore,
  opts: {
    readonly onStoreError?: (err: unknown) => void;
    /** ADR-0078: the picker reads use their own buckets so polling cannot starve a reassign or a create. */
    readonly keyPrefix?: string;
  } = {},
): AckRouteRateLimit {
  const { onStoreError } = opts;
  const prefix = opts.keyPrefix ?? ACK_RATE_LIMIT_KEY_PREFIX;
  const base = createRouteRateLimit({
    store,
    limit: ACK_ROUTE_RATE_LIMIT,
    keyPrefix: prefix,
    ...(onStoreError ? { onStoreError } : {}),
  });
  return async (request, reply) => {
    const { organizationId, userId } = request.context ?? {};
    if (!organizationId || !userId) throw new UnauthorizedError();
    await base(request, reply);
    const assignee = (request.body as { assigned_user_id?: unknown } | undefined)?.assigned_user_id;
    // A missing or malformed name is left to the route schema (it never reaches a key).
    if (typeof assignee !== "string" || !UUID.test(assignee)) return;
    let seen: number;
    try {
      seen = await store.increment(
        `${prefix}:pair:${organizationId}:${userId}:${assignee.toLowerCase()}`,
        ACK_PAIR_LIMIT.windowMs,
      );
      if (!Number.isInteger(seen) || seen < 1) throw new Error("bad count");
    } catch (err) {
      onStoreError?.(err);
      request.log.warn(
        { keyPrefix: prefix },
        "acknowledgment-request rate-limit store unavailable",
      );
      throw new DegradedError("rate-limit", "temporarily unavailable");
    }
    if (seen > ACK_PAIR_LIMIT.max) {
      reply.header("Retry-After", String(Math.ceil(ACK_PAIR_LIMIT.windowMs / 1000)));
      throw new RateLimitedError();
    }
  };
}
