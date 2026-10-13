// apps/backend/src/modules/36-messaging/presence/presence-store.ts - WP 2.12 ephemeral presence + typing.
//
// The port, plus the in-memory twin (tests, dev without REDIS_URL). NEVER persisted to Postgres: no table, no migration.
// Only ids are stored (org, channel, user) with a short TTL; no PHI, no message text, no display names.
// Writes are throttled per (org, channel, user, kind): inside the throttle window a call is a cheap no-op.

/** What a client is telling the server: "I am here" or "I am typing". */
export type PresenceKind = "present" | "typing";

export const PRESENCE_TTL_MS = 60_000;
export const TYPING_TTL_MS = 6_000;
/** At most one write per user per channel per kind in this window. */
export const PRESENCE_THROTTLE_MS = 3_000;
/** A channel never reports more than this many ids per kind (a bound on the response, not on membership). */
export const PRESENCE_LIST_LIMIT = 200;

export interface PresenceScope {
  readonly organizationId: string;
  readonly channelId: string;
}

export interface PresenceStore {
  /** Record `userId` as `kind` in the channel. `throttled` = inside the window, nothing was written. */
  mark(scope: PresenceScope, userId: string, kind: PresenceKind): Promise<"written" | "throttled">;
  /** Ids currently `kind` in the channel (unexpired), at most PRESENCE_LIST_LIMIT. */
  list(scope: PresenceScope, kind: PresenceKind): Promise<readonly string[]>;
}

export interface PresenceTimings {
  readonly presenceTtlMs: number;
  readonly typingTtlMs: number;
  readonly throttleMs: number;
}

export const DEFAULT_PRESENCE_TIMINGS: PresenceTimings = {
  presenceTtlMs: PRESENCE_TTL_MS,
  typingTtlMs: TYPING_TTL_MS,
  throttleMs: PRESENCE_THROTTLE_MS,
};

export const ttlFor = (timings: PresenceTimings, kind: PresenceKind): number =>
  kind === "typing" ? timings.typingTtlMs : timings.presenceTtlMs;

/** Single-process twin. Under several replicas each would see only its own callers: bind the Valkey store there. */
export function createInMemoryPresenceStore(
  now: () => number = Date.now,
  timings: PresenceTimings = DEFAULT_PRESENCE_TIMINGS,
): PresenceStore {
  const expiry = new Map<string, number>(); // `${kind}|${org}|${channel}|${user}` -> expires at
  const lastWrite = new Map<string, number>();
  const key = (kind: PresenceKind, scope: PresenceScope, userId: string): string =>
    `${kind}|${scope.organizationId}|${scope.channelId}|${userId}`;
  return {
    async mark(scope, userId, kind) {
      const t = now();
      const k = key(kind, scope, userId);
      const last = lastWrite.get(k);
      if (last !== undefined && t - last < timings.throttleMs) return "throttled";
      lastWrite.set(k, t);
      expiry.set(k, t + ttlFor(timings, kind));
      return "written";
    },
    async list(scope, kind) {
      const t = now();
      const prefix = `${kind}|${scope.organizationId}|${scope.channelId}|`;
      const live: string[] = [];
      for (const [k, expiresAt] of expiry) {
        if (expiresAt <= t) {
          expiry.delete(k);
          lastWrite.delete(k);
        } else if (k.startsWith(prefix)) {
          live.push(k.slice(prefix.length));
        }
      }
      return live.slice(0, PRESENCE_LIST_LIMIT);
    },
  };
}
