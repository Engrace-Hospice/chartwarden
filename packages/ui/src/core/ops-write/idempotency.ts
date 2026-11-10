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
