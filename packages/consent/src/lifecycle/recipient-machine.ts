// @chartwarden/consent — the consent_record_recipient lifecycle (§2.2.2, D6).
//
// M39-T04. Per-recipient consents only. A recipient is `added`, then either `removed` (removed_at
// set) or `expired` (its own expires_at passed). Adding/removing a recipient does NOT supersede the
// parent consent record — the recipient list is mutable independently of the consent scope. Removing
// the last active recipient leaves the consent `active` with zero recipients; evaluate then returns
// `no_active_recipient_matches` until one is added or the consent is revoked.
import { type Decision, deny, ok } from "./result";

export type RecipientState = "added" | "removed" | "expired";

/** Whether a recipient is currently active (not removed, not past its own expiry). Times are ms. */
export function recipientActive(input: {
  removedAtMs: number | null;
  expiresAtMs: number | null;
  nowMs: number;
}): boolean {
  if (input.removedAtMs !== null) return false;
  if (input.expiresAtMs !== null && input.expiresAtMs <= input.nowMs) return false;
  return true;
}

/** Refuse a double-remove (idempotency is the caller's; this is the friendly guard). */
export function removeRecipient(currentRemovedAtMs: number | null): Decision {
  if (currentRemovedAtMs !== null)
    return deny("recipient_already_removed", "recipient is already removed");
  return ok();
}

/** The evaluate-path verdict for a per-recipient consent: active iff ≥1 recipient is active. */
export function hasActiveRecipient(
  recipients: readonly { removedAtMs: number | null; expiresAtMs: number | null }[],
  nowMs: number,
): boolean {
  return recipients.some((r) => recipientActive({ ...r, nowMs }));
}
