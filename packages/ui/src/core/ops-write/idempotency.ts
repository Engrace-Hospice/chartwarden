// @chartwarden/ui core — one Idempotency-Key per attempt (§4.1.1).
//
// The API client mints a fresh key for every request that carries none, so a retry after a network failure is NOT a replay: the
// server cannot tell it from a second write. The platform console's writes (a location, a credential, a contract) must not double
// up, so an attempt holds ONE key:
//   - the same body keeps the same key, so a retry replays instead of writing twice;
//   - a changed body gets a new key (the same key with a different body is not safe);
//   - once the write has settled (success, or an answer the operator acts on), the next attempt starts on a new key.
import { useRef } from "react";

export interface IdempotencyKeeper {
  /** The key for an attempt with this body (JSON text or any stable fingerprint). */
  keyFor(fingerprint: string): string;
  /** The write got its answer: the next attempt starts fresh. */
  settled(): void;
}

function randomKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createIdempotencyKeeper(newKey: () => string = randomKey): IdempotencyKeeper {
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
