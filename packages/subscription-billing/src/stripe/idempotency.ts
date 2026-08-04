// @wardenx/subscription-billing — §4.13/§4.16 deterministic Stripe idempotency-key derivation (M35-T04).
//
// The outbound idempotency key is derived purely from `(operation, businessKey, attemptIndex)` — never from
// wall-clock or a random — so the SAME dispatch attempt always produces the SAME key. §4.13 pre-checks the
// key against `stripe_api_call_audit`, so a re-drained outbox job for an already-succeeded attempt is a
// no-op before any Stripe call happens. This is the outbound mechanism, ORTHOGONAL to the inbound
// `Idempotency-Key` header the M1 middleware handles in Valkey (§4.16). Pure — the §9.1 ≥95% strict target.

import type { StripeDispatchEvent } from "./types";

/** The fixed prefix of every outbound key (`stripe-idem-{op}-{businessKey}-{attempt}`, §4.13/§283). */
export const STRIPE_IDEMPOTENCY_PREFIX = "stripe-idem";

/** Characters other than `[a-z0-9_.-]` are collapsed to `-` so a businessKey with odd bytes still yields a
 *  Stripe-legal key (Stripe accepts ≤255 chars; we keep the alphabet tight and stable). */
function sanitizeSegment(segment: string): string {
  return segment.replace(/[^a-z0-9_.-]/gi, "-");
}

/**
 * §4.13 — derive the deterministic Stripe idempotency key for one dispatch attempt. Shape:
 * `stripe-idem-{operation}-{businessKey}-{attemptIndex}`. The operation is a closed {@link StripeOperation}
 * union; the businessKey is sanitized to the key-legal alphabet; the attempt index makes each retry a
 * distinct, individually-auditable key (§4.16).
 */
export function deriveIdempotencyKey(
  event: Pick<StripeDispatchEvent, "operation" | "businessKey" | "attemptIndex">,
): string {
  if (event.businessKey.length === 0) {
    throw new Error(
      "deriveIdempotencyKey: empty businessKey (a dispatch event must carry a stable identity)",
    );
  }
  if (!Number.isInteger(event.attemptIndex) || event.attemptIndex < 0) {
    throw new Error(
      `deriveIdempotencyKey: attemptIndex must be a non-negative integer, got ${event.attemptIndex}`,
    );
  }
  return [
    STRIPE_IDEMPOTENCY_PREFIX,
    sanitizeSegment(event.operation),
    sanitizeSegment(event.businessKey),
    String(event.attemptIndex),
  ].join("-");
}
