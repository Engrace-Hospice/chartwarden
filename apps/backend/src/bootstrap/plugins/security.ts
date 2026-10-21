// apps/backend/src/bootstrap/plugins/security.ts — M1 platform security baseline
// (spec §4.6.1 / M01-F10 / SD-055 / SEC-063..065 / ARCH-025; M1-T10).
//
// M1 owns the base Fastify host, so it wires the ONE security chain every module inherits
// (modules MUST NOT roll their own — SEC-064). This baseline is intentionally
// dependency-light for the vertical slice: it sets the helmet-equivalent response headers,
// the SD-055 rate-limit tiers, the explicit CORS allow-list, and (via buildServer) the
// 10 MB body limit — with NO new npm dependency.
//
// WX-PR-017: the limiter's counter store is now injectable (`rate-limit-store.ts`) — the
// composition root binds `createRedisRateLimitStore(queueConnection)` over the SAME Valkey
// connection the M34 BullMQ queues share when `REDIS_URL` is set, so the tier is enforced
// cluster-wide, not per-replica; `createInMemoryRateLimitStore()` (the default here) stays
// correct for a single instance, dev, and tests. The header set + tier values are unchanged
// from the hand-rolled baseline; a future `@fastify/helmet` swap must preserve them.
import { RateLimitedError } from "@chartwarden/types";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { type RateLimitStore, createInMemoryRateLimitStore } from "./rate-limit-store";

/** SD-055 tiers: 30/min unauthenticated, 600/min authenticated. */
export interface RateLimitTiers {
  readonly unauthenticatedPerMinute: number;
  readonly authenticatedPerMinute: number;
}

export const DEFAULT_RATE_LIMIT_TIERS: RateLimitTiers = {
  unauthenticatedPerMinute: 30,
  authenticatedPerMinute: 600,
};

export interface SecurityOptions {
  /** Allowed CORS origins (explicit allow-list — ARCH-025). Empty = no cross-origin. */
  readonly corsAllowOrigins?: readonly string[];
  readonly rateLimitTiers?: RateLimitTiers;
  /** Injectable clock (ms) so tests are deterministic; defaults to Date.now. */
  readonly now?: () => number;
  /** Set false to disable the limiter (e.g. a /ready probe storm in tests). */
  readonly rateLimitEnabled?: boolean;
  /** The counter store the limiter reads through. Defaults to a per-process `Map` — pass
   *  `createRedisRateLimitStore(queueConnection)` to enforce the tier cluster-wide. */
  readonly rateLimitStore?: RateLimitStore;
}

const WINDOW_MS = 60_000;

/** The helmet-equivalent response headers (SEC-063). */
function setSecurityHeaders(reply: FastifyReply): void {
  reply.header(
    "Content-Security-Policy",
    "default-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
  );
  reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-DNS-Prefetch-Control", "off");
}

export function applySecurityBaseline(app: FastifyInstance, opts: SecurityOptions = {}): void {
  const tiers = opts.rateLimitTiers ?? DEFAULT_RATE_LIMIT_TIERS;
  const now = opts.now ?? Date.now;
  const allowOrigins = new Set(opts.corsAllowOrigins ?? []);
  const limiterEnabled = opts.rateLimitEnabled ?? true;
  const store = opts.rateLimitStore ?? createInMemoryRateLimitStore(now);

  // Helmet-equivalent headers on every response.
  app.addHook("onSend", async (_request, reply, payload) => {
    setSecurityHeaders(reply);
    return payload;
  });

  // CORS allow-list (ARCH-025) + preflight short-circuit.
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = request.headers.origin;
    if (typeof origin === "string" && allowOrigins.has(origin)) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
      reply.header("Access-Control-Allow-Credentials", "true");
      reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
      reply.header(
        "Access-Control-Allow-Headers",
        "content-type,authorization,idempotency-key,x-correlation-id,x-csrf-token,x-invite-token",
      );
    }
    if (request.method === "OPTIONS") {
      // Preflight — answer here, after CORS headers are set.
      return reply.code(204).send();
    }
  });

  // Rate-limit (SD-055): keyed by org when org-bound, by user when signed in but pre-org, else by
  // client ip. WX-PR-018's E2E suite surfaced the bug this replaced: keying "authenticated" purely
  // on `organizationId` meant a freshly signed-in but not-yet-org-bound session (the sign-in →
  // select-organization window every login passes through) still read as unauthenticated and shared
  // the harsh 30/min IP-keyed tier with every anonymous caller behind the same address — a real
  // clinic's shared-NAT wifi with several staff logging in around the same time would trip this in
  // production, not just a test harness. `request.context.userId` is set by the authenticate hook as
  // soon as ANY valid session resolves (packages/auth identity — organizationId is set only after
  // the org bind), so it is the correct signal for "this caller already proved who they are."
  if (limiterEnabled) {
    app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
      const orgId = request.context?.organizationId;
      const userId = request.context?.userId;
      const authenticated =
        (typeof orgId === "string" && orgId.length > 0) ||
        (typeof userId === "string" && userId.length > 0);
      const limit = authenticated ? tiers.authenticatedPerMinute : tiers.unauthenticatedPerMinute;
      const bucketKey =
        typeof orgId === "string" && orgId.length > 0
          ? `org:${orgId}`
          : typeof userId === "string" && userId.length > 0
            ? `user:${userId}`
            : `ip:${request.ip}`;

      // Rate limiting is a defense-in-depth AVAILABILITY control, not an authorization gate — unlike
      // RLS/ABAC, a store outage must fail OPEN. The Redis-backed store is a real network dependency
      // on the hot path of every request; without this catch, a Valkey blip takes down 100% of API
      // traffic instead of the far smaller harm of briefly under-enforcing SD-055.
      let count: number;
      try {
        count = await store.increment(bucketKey, WINDOW_MS);
      } catch (err) {
        request.log.warn({ err, bucketKey }, "rate-limit store unavailable — failing open");
        return;
      }
      if (count > limit) {
        // The store only tells us "how many," not "when the window started" — a fixed
        // `WINDOW_MS / 1000` upper-bound retry hint is honest (the true remaining time is always
        // <= the full window) without the store needing a second call to report window age.
        reply.header("Retry-After", String(WINDOW_MS / 1000));
        throw new RateLimitedError();
      }
    });
  }
}
