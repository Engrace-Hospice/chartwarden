// apps/backend/src/modules/36-messaging/presence/binding.ts - WP 2.12: the composition-root binding for presence.
//
// Valkey when the boot has a connection (shared, cluster-wide), the in-memory twin otherwise (single instance / tests).
// The tenant flag is read per request through the platform's FeatureFlagReaderPort (tenant row wins; absent = off, a
// kill switch = off). The per-route limit is layered on the shared RateLimitStore; it fails OPEN because presence is a
// convenience: a Valkey blip must not turn into errors in the conversation view.
import {
  type RateLimitStore,
  createInMemoryRateLimitStore,
} from "../../../bootstrap/plugins/rate-limit-store";
import {
  type RouteRateLimit,
  createRouteRateLimit,
} from "../../../bootstrap/plugins/route-rate-limit";
import { PRESENCE_FLAG_KEY, type PresenceRouteDeps } from "../routes/presence-routes";
import { createInMemoryPresenceStore } from "./presence-store";
import { type ValkeyEvalClient, createValkeyPresenceStore } from "./valkey-presence-store";

/** Heartbeat (~every 25 s) + typing (at most every 3 s) + polling (~every 6 s) stay far below this per user. */
export const PRESENCE_ROUTE_RATE_LIMIT: RouteRateLimit = {
  perUser: 120,
  perOrg: 6_000,
  windowMs: 60_000,
  failMode: "open",
};

export interface PresenceBindingInput {
  readonly redis?: ValkeyEvalClient | undefined;
  readonly rateLimitStore?: RateLimitStore | undefined;
  readonly flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined;
  readonly onStoreError?: (err: unknown) => void;
}

/** Flag cache window: a tenant flag flip or kill switch takes effect on a replica within this long. */
export const PRESENCE_FLAG_CACHE_MS = 5_000;

/** Per-org TTL cache over an async flag read. Only successes are cached; a throw propagates and is retried next call. */
export function cacheFlagRead(
  read: (organizationId: string) => Promise<boolean>,
  ttlMs: number = PRESENCE_FLAG_CACHE_MS,
  now: () => number = Date.now,
): (organizationId: string) => Promise<boolean> {
  const cache = new Map<string, { value: boolean; expiresAt: number }>();
  return async (organizationId) => {
    const t = now();
    const hit = cache.get(organizationId);
    if (hit && hit.expiresAt > t) return hit.value;
    const value = await read(organizationId);
    cache.set(organizationId, { value, expiresAt: t + ttlMs });
    return value;
  };
}

export function buildPresenceDeps(input: PresenceBindingInput): PresenceRouteDeps {
  const { flags } = input;
  return {
    store: input.redis ? createValkeyPresenceStore(input.redis) : createInMemoryPresenceStore(),
    // Cached ~5 s per org: one DB read per org per window, not per heartbeat. A kill switch lands within that window.
    isEnabled: cacheFlagRead(async (organizationId) =>
      flags ? (await flags.forOrg(organizationId))[PRESENCE_FLAG_KEY] === true : false,
    ),
    rateLimit: createRouteRateLimit({
      store: input.rateLimitStore ?? createInMemoryRateLimitStore(),
      limit: PRESENCE_ROUTE_RATE_LIMIT,
      keyPrefix: "presence",
      ...(input.onStoreError ? { onStoreError: input.onStoreError } : {}),
    }),
  };
}
