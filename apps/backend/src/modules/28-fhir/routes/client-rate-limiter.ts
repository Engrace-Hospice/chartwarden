// apps/backend/src/modules/28-fhir/routes/client-rate-limiter.ts — GAP-083 / D16: the per-client token
// bucket. Capacity and refill are both `rateLimitRps`, so a client may burst to one second's allowance and
// is then held to the steady rate. Valkey-backed when REDIS_URL is set (one bucket across replicas), else a
// per-process bucket — the posture `bootstrap/plugins/rate-limit-store.ts` takes for the same reason.
//
// A store error degrades to the per-process bucket rather than to "unlimited": limiting is an availability
// control, so it must not take the surface down, but one replica's bucket still bounds a flood.

export interface FhirClientRateLimiter {
  consume(
    clientId: string,
    rps: number,
  ): Promise<{ readonly allowed: boolean; readonly retryAfterSeconds: number }>;
}

/** The slice of an ioredis client the limiter needs. */
export interface FhirRateLimitRedis {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

// KEYS[1] bucket hash; ARGV: capacity, refill per second. Time comes from the server so replicas agree.
const BUCKET_SCRIPT = `
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1])
local ts = tonumber(b[2])
if tokens == nil then tokens = capacity; ts = nowMs end
tokens = math.min(capacity, tokens + (math.max(0, nowMs - ts) / 1000) * rate)
local allowed = 0
local retryMs = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retryMs = math.ceil(((1 - tokens) / rate) * 1000)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', tostring(nowMs))
redis.call('PEXPIRE', KEYS[1], math.ceil((capacity / rate) * 1000) + 1000)
return { allowed, retryMs }
`;

const toRetrySeconds = (retryMs: number): number => Math.max(1, Math.ceil(retryMs / 1000));

export function createInMemoryFhirClientRateLimiter(
  now: () => number = Date.now,
): FhirClientRateLimiter {
  const buckets = new Map<string, { tokens: number; ts: number }>();
  return {
    async consume(clientId, rps) {
      const rate = Math.max(1, rps);
      const t = now();
      const prev = buckets.get(clientId) ?? { tokens: rate, ts: t };
      const tokens = Math.min(rate, prev.tokens + (Math.max(0, t - prev.ts) / 1000) * rate);
      if (tokens >= 1) {
        buckets.set(clientId, { tokens: tokens - 1, ts: t });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      buckets.set(clientId, { tokens, ts: t });
      return { allowed: false, retryAfterSeconds: toRetrySeconds(((1 - tokens) / rate) * 1000) };
    },
  };
}

export function createRedisFhirClientRateLimiter(
  redis: FhirRateLimitRedis,
  opts: { fallback?: FhirClientRateLimiter; onStoreError?: (err: unknown) => void } = {},
): FhirClientRateLimiter {
  const fallback = opts.fallback ?? createInMemoryFhirClientRateLimiter();
  return {
    async consume(clientId, rps) {
      const rate = Math.max(1, rps);
      try {
        const raw = await redis.eval(
          BUCKET_SCRIPT,
          1,
          `ratelimit:m28:client:${clientId}`,
          rate,
          rate,
        );
        const [allowed, retryMs] = Array.isArray(raw) ? raw.map(Number) : [Number.NaN, 0];
        if (allowed === 1) return { allowed: true, retryAfterSeconds: 0 };
        if (allowed === 0)
          return { allowed: false, retryAfterSeconds: toRetrySeconds(retryMs ?? 0) };
        throw new Error("unexpected token-bucket reply");
      } catch (err) {
        opts.onStoreError?.(err);
        return fallback.consume(clientId, rps);
      }
    },
  };
}
