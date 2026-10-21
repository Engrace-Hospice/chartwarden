// apps/backend/src/modules/36-messaging — the message-body KEY RING port + its TTL cache (WP 2.13 / ADR-0058 P1).
//
// M36 must not import M34 (M34 dependsOn M36), so the M34 `TenantKeyProvider` reaches the body cipher through THIS
// structural port, bound once at the composition root (`setMessageBodyKeyProvider`, apps/backend/src/index.ts).
//
// The provider unwraps the tenant DEK from the platform KEK on every call and reads `tenant_key_ring` on the PLATFORM
// pool (one round trip, a separate transaction). A thread read opens up to a page of bodies, so the hot path must not pay
// that per message: {@link createRingDekCache} memoises the current DEK and each prior version per org with a TTL.
//
// SHRED / ROTATION SEMANTICS OF THE CACHE. The composition root calls `invalidateMessageBodyKeys()` in THIS process right
// after M34's `m34_destroy_tenant_key_ring` commits (index.ts `destroyTenantKeyRing`) and when a `dek_rotation_completed`
// event is published, so a destroyed ring is honoured immediately here. OTHER processes (api replicas, workers) have no
// such hook: they keep a cached DEK for at most one TTL (60 s) after a destruction, which is the stated exposure window. A
// destroyed ring is never cached (the provider throws and a rejection is not memoised). A rotation is harmless for reads
// (the envelope names its version); a stale "current" only means a write is sealed under the previous, still-retained,
// version for up to one TTL.
import type { RingBodyDek } from "@chartwarden/messaging";
import { DegradedError } from "@chartwarden/types";

/**
 * The key for a body could not be obtained (provider outage, unbound KEK, destroyed or missing ring, absent legacy key). This is
 * NOT evidence about the ciphertext: callers that judge integrity (hash_verify) or return hits (search) must not treat it as a
 * GCM authentication failure. It is a 503-class DegradedError carrying the cause.
 */
export class BodyKeyUnavailableError extends DegradedError {
  /** The ring was destroyed (M34 crypto-shred): permanent and authorised, unlike an outage. */
  readonly destroyed: boolean;
  constructor(override readonly cause: unknown) {
    super(
      "message-body-key",
      `body key unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "BodyKeyUnavailableError";
    this.destroyed = cause instanceof Error && cause.name === "TenantKeyDestroyed";
  }
}

/** The slice of M34's `TenantKeyProvider` the body cipher needs (structural: no M34 import). */
export interface MessageBodyKeyProvider {
  dekForOrg(orgId: string): Promise<RingBodyDek>;
  dekForOrgVersion(orgId: string, version: string): Promise<RingBodyDek>;
}

export const RING_DEK_CACHE_TTL_MS = 60_000;
const RING_DEK_CACHE_MAX_ENTRIES = 4_096;

export interface RingDekCache {
  /** The active ring DEK for the org (what a new write seals under). */
  current(orgId: string): Promise<RingBodyDek>;
  /** The DEK of a specific ring version (what an envelope names). */
  byVersion(orgId: string, version: string): Promise<RingBodyDek>;
  /** Drop every cached DEK of one org (shred / rotation), or all of them. */
  invalidate(orgId?: string): void;
}

interface Entry {
  readonly value: Promise<RingBodyDek>;
  readonly expiresAt: number;
}

export function createRingDekCache(
  keys: MessageBodyKeyProvider,
  opts: { ttlMs?: number; now?: () => number } = {},
): RingDekCache {
  const ttlMs = opts.ttlMs ?? RING_DEK_CACHE_TTL_MS;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();

  const remember = (cacheKey: string, load: () => Promise<RingBodyDek>): Promise<RingBodyDek> => {
    const hit = entries.get(cacheKey);
    if (hit && hit.expiresAt > now()) return hit.value;
    const value = load();
    if (entries.size >= RING_DEK_CACHE_MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    entries.set(cacheKey, { value, expiresAt: now() + ttlMs });
    // A failure (destroyed / missing ring, KEK unbound) must never be memoised: the next call asks again.
    value.catch(() => {
      if (entries.get(cacheKey)?.value === value) entries.delete(cacheKey);
    });
    return value;
  };

  return {
    current: (orgId) => remember(`c\0${orgId}`, () => keys.dekForOrg(orgId)),
    byVersion: (orgId, version) =>
      remember(`v\0${orgId}\0${version}`, () => keys.dekForOrgVersion(orgId, version)),
    invalidate(orgId) {
      if (orgId === undefined) return entries.clear();
      for (const k of [...entries.keys()]) {
        if (k.split("\0")[1] === orgId) entries.delete(k);
      }
    },
  };
}

// ── composition-root binding ─────────────────────────────────────────────────────────────────────────

let resolveKeys: (() => MessageBodyKeyProvider) | undefined;
let sharedCache: RingDekCache | undefined;
let sharedCacheFor: MessageBodyKeyProvider | undefined;

/** Bind the (lazy) M34 key provider. Called once at boot; resolved per use so boot order does not matter. */
export function setMessageBodyKeyProvider(
  resolve: (() => MessageBodyKeyProvider) | undefined,
): void {
  resolveKeys = resolve;
  sharedCache = undefined;
  sharedCacheFor = undefined;
}

/** The process-wide ring-DEK cache over the bound provider, or `undefined` when none is bound. */
export function sharedRingDekCache(): RingDekCache | undefined {
  if (!resolveKeys) return undefined;
  const provider = resolveKeys();
  if (sharedCache && sharedCacheFor === provider) return sharedCache;
  sharedCache = createRingDekCache(provider);
  sharedCacheFor = provider;
  return sharedCache;
}

/** Drop the shared cache's DEKs for an org (called when its ring is rotated or destroyed in this process). */
export function invalidateMessageBodyKeys(orgId?: string): void {
  sharedCache?.invalidate(orgId);
}
