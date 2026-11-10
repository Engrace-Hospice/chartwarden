// @chartwarden/ui core — the ONE attempt-key implementation for a screen that holds an Idempotency-Key across a retry. A screen asks it
// for the key of an intent (`keyFor` / `attemptFor` / `run`) and tells it how the attempt ended (`settle` / `run`); the rules are the
// shared ones (idempotency-key.ts), and every screen-level helper that used to hold keys itself is this:
//   - the key is kept across no answer (a thrown request, an abort), a gateway page, and the "earlier request is still running" 409;
//   - any other answer, success or refusal, renews it;
//   - it lapses a TTL after the last unanswered attempt (an in-flight 409 does not slide that) and never outlives the hard cap;
//   - an intent is its fingerprint: a changed request gets a new key, and an older intent's key survives another being sent between;
//   - every table is dropped with the rest when the app clears held keys at the end of a session (`clearIdempotencyKeys(client)`).
// It is a table of keepers, one per intent still waiting for its answer, so the rules live in createIdempotencyKeeper alone.
// A new screen that needs a held key uses this hook; scripts/__tests__/attempt-key-guard.test.ts fails on a home-grown one.
import { useEffect, useRef } from "react";
import {
  type IdempotencyAttempt,
  type IdempotencyKeeper,
  createIdempotencyKeeper,
} from "./idempotency";
import {
  MAX_TRACKED_INTENTS,
  isInFlightDuplicate,
  keepsKey,
  newIdempotencyKey,
  opaqueIdempotencyIntent,
  registerHeldKeys,
} from "./idempotency-key";
import type { WriteResponse } from "./send-write";

/** The HTTP status of a request that got no answer at all (offline, a reset, an abort). */
export const NO_ANSWER = 0;
/** A request that resolved with no `response` still got an answer: it is read as an ordinary success, never as a held key. */
const ANSWERED_WITHOUT_STATUS = 200;

export interface AttemptKey {
  /** The key for an attempt of this intent: the same one while the intent is held, a new one for a changed or lapsed intent. */
  keyFor(fingerprint: string): string;
  /** `keyFor`, plus the intent's first-attempt time (see IdempotencyAttempt.stampedAt). */
  attemptFor(fingerprint: string): IdempotencyAttempt;
  /**
   * How the attempt ended: `NO_ANSWER` (0) for a request that got none, else the HTTP status and the parsed error body (for the gateway
   * page and in-flight 409 reading). Judges `fingerprint`, by default the intent `keyFor` / `attemptFor` last handed out.
   */
  settle(status: number, body?: unknown, fingerprint?: string): void;
  /** Drop one intent's key (default: the last one handed out): an explicit reset. */
  forget(fingerprint?: string): void;
  /**
   * Run one request under the intent's key and settle it from its result (an openapi-fetch `{ error, response }`). A request that
   * throws got no answer: its key is held and the error is rethrown.
   */
  run<R extends WriteResponse>(
    fingerprint: string,
    send: (idempotencyKey: string, stampedAt: string) => Promise<R>,
  ): Promise<R>;
  /** Forget every intent (the session ended). */
  clear(): void;
}

export function createAttemptKey(
  newKey: () => string = newIdempotencyKey,
  now: () => number = Date.now,
): AttemptKey {
  interface HeldIntent {
    readonly keeper: IdempotencyKeeper;
    active: number;
  }
  // Only opaque salted digests are retained: a caller's fingerprint may contain clinical text. Insertion order is age.
  const salt = newIdempotencyKey();
  const intentKey = (fingerprint: string): string => opaqueIdempotencyIntent(fingerprint, salt);
  const held = new Map<string, HeldIntent>();
  let last: string | null = null;

  function evictOldestIdle(): void {
    let idle = 0;
    for (const intent of held.values()) if (intent.active === 0) idle += 1;
    for (const [key, intent] of held) {
      if (idle <= MAX_TRACKED_INTENTS) return;
      if (intent.active === 0) {
        held.delete(key);
        idle -= 1;
      }
    }
  }

  function attemptFor(fingerprint: string): IdempotencyAttempt {
    const key = intentKey(fingerprint);
    let intent = held.get(key);
    if (intent === undefined) {
      intent = { keeper: createIdempotencyKeeper(newKey, now), active: 0 };
      held.set(key, intent);
    }
    intent.active += 1;
    last = key;
    evictOldestIdle();
    return intent.keeper.attemptFor(key);
  }

  function settle(status: number, body?: unknown, fingerprint?: string): void {
    const key = fingerprint === undefined ? last : intentKey(fingerprint);
    const intent = key === null ? undefined : held.get(key);
    if (key === null || intent === undefined) return;
    intent.active = Math.max(0, intent.active - 1);
    if (status !== NO_ANSWER && !keepsKey(status, body)) {
      intent.keeper.settled();
      held.delete(key);
    } else if (status === NO_ANSWER || !isInFlightDuplicate(status, body)) {
      intent.keeper.unanswered();
    }
    evictOldestIdle();
  }

  return {
    keyFor: (fingerprint) => attemptFor(fingerprint).key,
    attemptFor,
    settle,
    forget(fingerprint) {
      const key = fingerprint === undefined ? last : intentKey(fingerprint);
      if (key !== null) held.delete(key);
    },
    async run<R extends WriteResponse>(
      fingerprint: string,
      send: (idempotencyKey: string, stampedAt: string) => Promise<R>,
    ): Promise<R> {
      const { key, stampedAt } = attemptFor(fingerprint);
      let result: R;
      try {
        result = await send(key, stampedAt);
      } catch (error) {
        settle(NO_ANSWER, undefined, fingerprint);
        throw error;
      }
      settle(result?.response?.status ?? ANSWERED_WITHOUT_STATUS, result?.error, fingerprint);
      return result;
    },
    clear() {
      held.clear();
      last = null;
    },
  };
}

/**
 * The attempt keys of module-level API functions, which have no component to hold a hook: one table for the page, built the same way as a
 * screen's and dropped with it when the session ends. A function that sends a write whose contract DECLARES the Idempotency-Key header (so
 * the key cannot simply be left to the API client) wraps its request in `sharedAttemptKeys.run(fingerprint, (key) => ...)`, the
 * fingerprint naming the intent (route, ids, version, body). Everything else leaves the key to the client.
 */
export const sharedAttemptKeys: AttemptKey = createAttemptKey();
registerHeldKeys(sharedAttemptKeys.clear);

/** A screen's attempt keys: one stable object per component, dropped with the other held keys when the session ends. */
export function useAttemptKey(): AttemptKey {
  const ref = useRef<AttemptKey | null>(null);
  if (ref.current === null) ref.current = createAttemptKey();
  const attempt = ref.current;
  useEffect(() => registerHeldKeys(attempt.clear), [attempt]);
  return attempt;
}
