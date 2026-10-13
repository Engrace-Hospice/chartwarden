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

export function buildPresenceDeps(input: PresenceBindingInput): PresenceRouteDeps {
  const { flags } = input;
  return {
    store: input.redis ? createValkeyPresenceStore(input.redis) : createInMemoryPresenceStore(),
    isEnabled: async (organizationId) =>
      flags ? (await flags.forOrg(organizationId))[PRESENCE_FLAG_KEY] === true : false,
    rateLimit: createRouteRateLimit({
      store: input.rateLimitStore ?? createInMemoryRateLimitStore(),
      limit: PRESENCE_ROUTE_RATE_LIMIT,
      keyPrefix: "presence",
      ...(input.onStoreError ? { onStoreError: input.onStoreError } : {}),
    }),
  };
}
