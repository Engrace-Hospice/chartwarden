// @chartwarden/ui core — the one Idempotency-Key generator. Pure (no React), so the API client's middleware and the keeper hook share it
// without the client pulling React in.

/** A new key: `crypto.randomUUID()`, or a time-plus-random string where it is unavailable (an insecure context such as plain http on a LAN). */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    return crypto.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
