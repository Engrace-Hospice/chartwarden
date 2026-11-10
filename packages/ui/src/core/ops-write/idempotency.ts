// @chartwarden/ui core — one Idempotency-Key per attempt (§4.1.1).
//
// A write must not double up when its reply is lost (a location, a credential, a contract), so an attempt holds ONE key:
//   - the same body keeps the same key, so a retry replays instead of writing twice;
//   - a changed body gets a new key (the same key with a different body is not safe);
//   - once the server has ANSWERED, the next attempt starts on a new key. The server caches whatever it answered under the key,
//     refusals included (a 403 STEP_UP_REQUIRED, a 409, a 422), so a retry on the same key after re-verifying would be handed the
//     cached refusal and could never succeed. Only a request that got no answer at all (the network dropped it) retries on its key.
// The keeper holds that rule for a screen that supplies its own key (a form or dialog, via `sendWrite` / `useOpsWrite`). The API client
// applies the same rule on its own to every mutating request that carries no key (api/idempotency-middleware.ts), keyed by method + URL
// + body; a request that supplies a key is never touched by it, so the two do not interfere.
import { useRef } from "react";
import { newIdempotencyKey } from "./idempotency-key";

export interface IdempotencyKeeper {
  /** The key for an attempt with this body (JSON text or any stable fingerprint). */
  keyFor(fingerprint: string): string;
  /** The server answered (success OR refusal): the next attempt starts on a new key. */
  settled(): void;
}

export function createIdempotencyKeeper(
  newKey: () => string = newIdempotencyKey,
): IdempotencyKeeper {
  let current: { readonly fingerprint: string; readonly key: string } | null = null;
  return {
    keyFor(fingerprint) {
      if (current === null || current.fingerprint !== fingerprint) {
        current = { fingerprint, key: newKey() };
      }
      return current.key;
    },
    settled() {
      current = null;
    },
  };
}

/** A keeper that lives as long as the component that submits (one per form or dialog). */
export function useIdempotencyKeeper(): IdempotencyKeeper {
  const ref = useRef<IdempotencyKeeper | null>(null);
  if (ref.current === null) ref.current = createIdempotencyKeeper();
  return ref.current;
}
