// @chartwarden/ui core — one Idempotency-Key per write intent (§4.1.1), held for a screen that supplies its own key.
//
// A write must not double up when its reply is lost (a location, a credential, a contract), so one intent holds ONE key:
//   - the same body keeps the same key, so a retry replays instead of writing twice;
//   - a changed body gets a new key (the same key with a different body is not safe);
//   - once the server has ANSWERED, the next attempt starts on a new key. The server caches a completed answer under the key,
//     refusals included (a 403 STEP_UP_REQUIRED, a 409, a 422), so a retry on the same key after re-verifying would be handed the
//     cached refusal and could never succeed. Only a request that got no answer at all (the network dropped it) retries on its key,
//     and so does a gateway page or an "earlier request under this key is still running" 409 (`keepsKey`, idempotency-key.ts).
// A screen that never supplies a key needs none of this: the API client applies the same renewal rule (`keepsKey`) to every keyless
// mutating request, keyed by method + URL + If-Match + body (api/idempotency-middleware.ts). A request that supplies its own key,
// as `sendWrite` / `useOpsWrite` do from this keeper, is never touched by that middleware, so the two do not interfere.
import { useEffect, useRef } from "react";
import {
  keyIdleTooLong,
  keyPastMaxAge,
  newIdempotencyKey,
  registerHeldKeys,
} from "./idempotency-key";

/** One attempt of an intent: its key, and the time of the intent's FIRST attempt, stable across retries until it settles. */
export interface IdempotencyAttempt {
  readonly key: string;
  /**
   * ISO time the intent started. For a body that carries a click-time clock value (a signature time): send THIS, not `new Date()`.
   * The server hashes the whole body under the key, so a retry on the same key with a newer clock value is refused as a different
   * body; one stable value per intent is what lets the retry replay. Leave such a field out of the fingerprint.
   */
  readonly stampedAt: string;
}

export interface IdempotencyKeeper {
  /** The key for an attempt with this body (JSON text or any stable fingerprint). */
  keyFor(fingerprint: string): string;
  /** `keyFor`, plus the intent's first-attempt time (see {@link IdempotencyAttempt.stampedAt}). */
  attemptFor(fingerprint: string): IdempotencyAttempt;
  /** The server answered (success OR refusal): the next attempt starts on a new key. */
  settled(): void;
  /** The attempt ended with no answer, or only a gateway page: the retry replays on this key, and the idle window restarts. */
  unanswered(): void;
}

interface TrackedAttempt {
  readonly fingerprint: string;
  readonly key: string;
  readonly stampedAt: string;
  readonly firstAttemptAt: number;
  readonly lastAttemptAt: number;
}

/**
 * The key is held for the SAME intent across a retry, with the middleware's bounds (idempotency-key.ts): it lapses a TTL after the last
 * unanswered attempt, and never outlives the hard cap from the first one. Without them an "an earlier request is still running" 409
 * (which holds the key and does not slide the window) would repeat for as long as the form stayed mounted when a server crash left the
 * claim pending for its whole 24h. `now` is injectable for tests.
 */
export function createIdempotencyKeeper(
  newKey: () => string = newIdempotencyKey,
  now: () => number = Date.now,
): IdempotencyKeeper {
  let current: TrackedAttempt | null = null;

  function begin(fingerprint: string): TrackedAttempt {
    const at = now();
    const reusable =
      current !== null &&
      current.fingerprint === fingerprint &&
      !keyPastMaxAge(current.firstAttemptAt, at) &&
      !keyIdleTooLong(current.lastAttemptAt, at);
    if (current === null || !reusable) {
      current = {
        fingerprint,
        key: newKey(),
        stampedAt: new Date(at).toISOString(),
        firstAttemptAt: at,
        lastAttemptAt: at,
      };
    }
    return current;
  }

  return {
    keyFor: (fingerprint) => begin(fingerprint).key,
    attemptFor(fingerprint) {
      const { key, stampedAt } = begin(fingerprint);
      return { key, stampedAt };
    },
    settled() {
      current = null;
    },
    unanswered() {
      if (current !== null) current = { ...current, lastAttemptAt: now() };
    },
  };
}

/** A keeper that lives as long as the component that submits (one per form or dialog); dropped with the other held keys when the session ends. */
export function useIdempotencyKeeper(): IdempotencyKeeper {
  const ref = useRef<IdempotencyKeeper | null>(null);
  if (ref.current === null) ref.current = createIdempotencyKeeper();
  const keeper = ref.current;
  useEffect(() => registerHeldKeys(() => keeper.settled()), [keeper]);
  return keeper;
}
