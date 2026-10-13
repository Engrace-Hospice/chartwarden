// apps/backend/src/modules/36-messaging/presence/valkey-presence-store.ts - WP 2.12: the Valkey-backed PresenceStore.
//
// One sorted set per (org, channel, kind): member = user id, score = expiry in Valkey-server milliseconds (the server
// clock, not the replica's, so skew between backend replicas is irrelevant). A second plain key per (org, channel, kind,
// user) carries the throttle (SET NX PX). Both keys expire on their own; reads prune the set. `{org:channel}` is a hash
// tag so the keys of one script share a slot on a clustered deployment. Ids only: no PHI, no text, no names.
import {
  DEFAULT_PRESENCE_TIMINGS,
  PRESENCE_LIST_LIMIT,
  type PresenceKind,
  type PresenceScope,
  type PresenceStore,
  type PresenceTimings,
  ttlFor,
} from "./presence-store";

/** The one ioredis method used; structural so this module takes no dependency on the client library. */
export interface ValkeyEvalClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

const MARK_SCRIPT = `
if not redis.call('SET', KEYS[2], '1', 'NX', 'PX', ARGV[3]) then return 0 end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1
`;

const LIST_SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
return redis.call('ZRANGE', KEYS[1], 0, tonumber(ARGV[1]) - 1)
`;

const setKey = (scope: PresenceScope, kind: PresenceKind): string =>
  `presence:{${scope.organizationId}:${scope.channelId}}:${kind}`;
const throttleKey = (scope: PresenceScope, kind: PresenceKind, userId: string): string =>
  `${setKey(scope, kind)}:throttle:${userId}`;

export function createValkeyPresenceStore(
  redis: ValkeyEvalClient,
  timings: PresenceTimings = DEFAULT_PRESENCE_TIMINGS,
): PresenceStore {
  return {
    async mark(scope, userId, kind) {
      const written = await redis.eval(
        MARK_SCRIPT,
        2,
        setKey(scope, kind),
        throttleKey(scope, kind, userId),
        userId,
        ttlFor(timings, kind),
        timings.throttleMs,
      );
      return Number(written) === 1 ? "written" : "throttled";
    },
    async list(scope, kind) {
      const ids = await redis.eval(LIST_SCRIPT, 1, setKey(scope, kind), PRESENCE_LIST_LIMIT);
      return Array.isArray(ids) ? ids.map(String) : [];
    },
  };
}
