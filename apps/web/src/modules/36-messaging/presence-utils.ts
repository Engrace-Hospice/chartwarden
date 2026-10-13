// WP 2.12 presence helpers: pure, so the wording and the timing are unit-tested without a DOM.

/** The tenant feature flag (default off). The UI renders nothing and requests nothing while it is false. */
export const PRESENCE_FLAG_KEY = "messaging.presence_enabled";

export const HEARTBEAT_INTERVAL_MS = 25_000;
export const POLL_INTERVAL_MS = 6_000;
/** The server throttles at 3 s; asking more often is only a wasted request. */
export const TYPING_THROTTLE_MS = 3_000;
export const MAX_BACKOFF_MS = 120_000;
const JITTER_FRACTION = 0.2;
const MAX_NAMED_TYPISTS = 3;
const UNKNOWN_NAME = "A colleague";

/** `base` +/- 20 %, so a room full of tabs does not poll in lockstep. */
export function jittered(baseMs: number, random: () => number = Math.random): number {
  return Math.round(baseMs * (1 - JITTER_FRACTION + 2 * JITTER_FRACTION * random()));
}

/** Delay after `failures` consecutive errors: doubles, capped. */
export function backoffDelay(baseMs: number, failures: number): number {
  return Math.min(baseMs * 2 ** failures, MAX_BACKOFF_MS);
}

/** "Alex is typing…", up to three names, then "Several people are typing…". Empty when nobody is. */
export function typingLabel(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length > MAX_NAMED_TYPISTS) return "Several people are typing…";
  if (names.length === 1) return `${names[0]} is typing…`;
  const head = names.slice(0, -1).join(", ");
  return `${head} and ${names[names.length - 1]} are typing…`;
}

export function displayNameFor(names: ReadonlyMap<string, string>, userId: string): string {
  return names.get(userId) ?? UNKNOWN_NAME;
}
