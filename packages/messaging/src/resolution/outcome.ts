// @wardenx/messaging — alert outcome computation (M36-T04, spec §2.4.3).
//
// Roll the settled per-(recipient × channel) deliveries up into the parent alert's terminal
// outcome (§2.4.3): `delivered` when the in-app floor reached every recipient and nothing
// failed; `failed` when no recipient was reached on any channel (the §2.6 ops-paged Tier-1
// case); `partial` otherwise. Pure: the dispatcher (M36-T08) collects vendor/socket callbacks
// into these settlements and calls this to stamp `alert.outcome`.

import type {
  AlertOutcome,
  NotificationChannel,
  NotificationStatus,
  SettledAlertOutcome,
} from "../interfaces/kinds";
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
export function computeOutcome(settlements: readonly DeliverySettlement[]): SettledAlertOutcome {
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

// ── the §2.4.3 roll-up over a live delivery set (F-109) ─────────────────────────────────────────────────

/**
 * The §2.4.4 states a `notification_delivery` never leaves. `pending` and `sent` are IN FLIGHT: the row
 * is still waiting for a channel to say what happened to it, and an alert holding one has not settled.
 */
const TERMINAL: ReadonlySet<NotificationStatus> = new Set<NotificationStatus>([
  "delivered",
  "failed",
  "skipped_quiet_hours",
  "forwarded",
]);

export function isTerminalDeliveryStatus(status: NotificationStatus): boolean {
  return TERMINAL.has(status);
}

/** One live `notification_delivery` row, as the roll-up reads it. */
export interface DeliveryRollupRow {
  readonly recipientUserId: string;
  readonly channel: NotificationChannel;
  readonly status: NotificationStatus;
}

/**
 * Roll a live delivery set up into the parent `alert.outcome` (§2.4.3). This is the caller
 * {@link computeOutcome} never had, and the two halves it adds are the reason it could not simply BE
 * `computeOutcome`:
 *
 *  • A row still in flight means the alert has not settled — `pending`, the state migration 0240 gave the
 *    enum. Feeding in-flight rows to `computeOutcome` as `delivered: false` would settle the alert
 *    `partial` (or `failed`) the instant it was written, which is a WRONG terminal answer rather than an
 *    honest provisional one, and it is terminal so nothing would ever revisit it.
 *  • An EMPTY set settles immediately as `failed` — `computeOutcome`'s own documented answer, "nobody was
 *    reached". This is the common case in this deployment and the one the old `DEFAULT 'delivered'` was
 *    most wrong about: `emit()` writes a no-op alert when no `alert_rule` fires, so an event that matched
 *    nothing recorded itself as successfully delivered to the zero people it reached.
 */
export function rollUpAlertOutcome(rows: readonly DeliveryRollupRow[]): AlertOutcome {
  if (rows.some((r) => !isTerminalDeliveryStatus(r.status))) return "pending";
  return computeOutcome(
    rows.map((r) => ({
      recipientUserId: r.recipientUserId,
      channel: r.channel,
      delivered: r.status === "delivered",
    })),
  );
}
