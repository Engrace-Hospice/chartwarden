// @wardenx/messaging — alert outcome computation (M36-T04, spec §2.4.3).
//
// Roll the settled per-(recipient × channel) deliveries up into the parent alert's terminal
// outcome (§2.4.3): `delivered` when the in-app floor reached every recipient and nothing
// failed; `failed` when no recipient was reached on any channel (the §2.6 ops-paged Tier-1
// case); `partial` otherwise. Pure: the dispatcher (M36-T08) collects vendor/socket callbacks
// into these settlements and calls this to stamp `alert.outcome`.

import type { AlertOutcome, NotificationChannel } from "../interfaces/kinds";
import { FLOOR_CHANNEL } from "./preferences";

/** A settled delivery as seen by the outcome roll-up: did the channel acknowledge delivery? */
export interface DeliverySettlement {
  /** The user the alert was *for* — the original recipient, even when the row was forwarded. */
  readonly recipientUserId: string;
  readonly channel: NotificationChannel;
  /** True once the channel acked delivery (in-app: socket ack; SMS/email: vendor webhook). */
  readonly delivered: boolean;
}

/**
 * Compute an alert's §2.4.3 outcome from its settled deliveries.
 *   • `failed`    — not a single delivery landed on any channel (ops-paged for Tier-1, §2.6).
 *   • `delivered` — every resolved recipient got their in-app floor AND nothing failed/skipped.
 *   • `partial`   — anything in between.
 * An empty settlement set is `failed` (nobody was reached).
 */
export function computeOutcome(settlements: readonly DeliverySettlement[]): AlertOutcome {
  if (settlements.length === 0) return "failed";

  const anyDelivered = settlements.some((s) => s.delivered);
  if (!anyDelivered) return "failed";

  const recipients = new Set(settlements.map((s) => s.recipientUserId));
  const floorDelivered = new Set(
    settlements
      .filter((s) => s.channel === FLOOR_CHANNEL && s.delivered)
      .map((s) => s.recipientUserId),
  );
  const everyRecipientGotFloor = [...recipients].every((r) => floorDelivered.has(r));
  const anyFailure = settlements.some((s) => !s.delivered);

  return everyRecipientGotFloor && !anyFailure ? "delivered" : "partial";
}
