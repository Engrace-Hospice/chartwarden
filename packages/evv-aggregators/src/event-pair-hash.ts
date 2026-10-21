// @chartwarden/evv-aggregators — the §2.2.5 / §2.3 idempotency primitive (M18-T06).
//
// `event_pair_hash = SHA-256(check_in_event_id || check_out_event_id)`. Deterministic, so a retried submission
// for the same (visit, event-pair) carries the SAME key and the vendor (or its circuit-breaker) dedupes it —
// no double-submission. A correction-of-record changes an event id, the hash differs, and a NEW submission is
// allowed (D7 alternative (c)). The ordered concatenation is canonical (check-in first, check-out second).
import { createHash } from "node:crypto";

/** The deterministic SHA-256 idempotency hash over an ordered (check_in, check_out) event-id pair (§2.2.5). */
export function eventPairHash(checkInEventId: string, checkOutEventId: string): string {
  return createHash("sha256").update(`${checkInEventId}||${checkOutEventId}`).digest("hex");
}
