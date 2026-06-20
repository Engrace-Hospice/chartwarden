// @wardenx/messaging — cache key grammar + TTLs + invalidation (M36-T08, spec §4.8).
//
// Pure, infra-free key construction for the three §4.8 messaging caches. The keys + TTLs live here
// so the realtime/read paths (room-set computation, recipient resolution, unread badges) and the
// invalidation path (permissions.changed, member add/remove, on-call rotation, message.new/read)
// agree on EXACTLY one grammar — a mismatch would leave stale rows nobody can purge. The Valkey
// adapter (production) and the in-memory cache (slice/tests, ./store) both key on these strings;
// this module imports no client.
//
//   • room membership   rooms:user:<userId>                         set;  TTL = session length
//   • recipient resolver recip:<resolverName>:<orgId>:<argsHash>     str;  TTL 60s   (§4.8)
//   • channel unread     unread:user:<userId>  (hash field=channelId) hash; no TTL  (§4.8)
//
// §4.8 hard rule encoded here: quiet-hours and vacation evaluation are NEVER cached (must always be
// fresh) — there is deliberately no key for them, and `recipientResolverKey` is only ever built for
// the membership-style resolvers (care_team/on_call/discipline/role_set), never the freshness ones.

/** Cache TTLs in seconds, per §4.8. Room membership rides the session (caller passes the length). */
export const MESSAGING_CACHE_TTL_SECONDS = {
  /** Recipient-resolver result cache — brief, covers bursts of similar alerts (§4.8). */
  recipientResolver: 60,
} as const;

/** `rooms:user:<userId>` — the user's Socket.IO room set, cached on connect (§4.8, §4.3). */
export function roomMembershipKey(userId: string): string {
  return `rooms:user:${userId}`;
}

/**
 * `recip:<resolverName>:<orgId>:<argsHash>` — a memoised recipient-resolver result (§4.8). Keyed by
 * resolver name + org + a stable hash of the resolver args, so two `visit.late` alerts for the same
 * scheduler share one 60s entry. The QUIET-HOURS and VACATION resolvers are excluded by contract —
 * those are evaluated fresh on every fan-out (§4.8), so no key is ever built for them.
 */
export function recipientResolverKey(
  resolverName: string,
  orgId: string,
  argsHash: string,
): string {
  return `recip:${resolverName}:${orgId}:${argsHash}`;
}

/**
 * `recip:<resolverName>:` — the prefix purged when a resolver's source-of-truth shifts (e.g. an
 * on-call rotation invalidates every cached `on_call` result across orgs). `orgId` is the THIRD key
 * segment, so org-scoped invalidation isn't a prefix op — the Valkey adapter keeps a per-org index
 * set for that; resolver-wide purge (the common case) is this true prefix.
 */
export function recipientResolverPrefix(resolverName: string): string {
  return `recip:${resolverName}:`;
}

/** `unread:user:<userId>` — the Valkey hash of per-channel unread counts for one user (§4.8). */
export function unreadCountKey(userId: string): string {
  return `unread:user:${userId}`;
}

/**
 * A stable, dependency-free hash of recipient-resolver args, for the resolver cache key. FNV-1a over
 * a canonical key=value rendering — deterministic across runs (no clock/RNG), collision-cheap enough
 * for a best-effort 60-second cache. NOT a security hash. Mirrors the M38 cache `hashQueryOpts`.
 */
export function hashResolverArgs(args: Readonly<Record<string, unknown>> = {}): string {
  const canonical = Object.keys(args)
    .sort()
    .map((k) => `${k}=${String(args[k])}`)
    .join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
