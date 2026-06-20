// @wardenx/messaging — the fan-out planner (M36-T04, spec §2.1, §2.4.4, §2.5, §2.6).
//
// Given an alert (category, severity), the firing rule's optional channel override, and the
// resolved recipients' preferences, compute the `notification_delivery` plan: one row per
// (recipient × channel) with its initial §2.4.4 status. Pure and deterministic — the DB-backed
// dispatcher (M36-T08) persists these rows and hands them to the per-channel dispatchers.
//
// The three §2.1 principles live here:
//   1. In-app is the always-available floor — EVERY recipient gets an `in_app` delivery, never
//      suppressed by quiet hours and never forwarded away (a connected user still sees it).
//   2. Out-of-band channels are additive per preference (or the rule's `channels_override`),
//      gated by the voice-SOS-only rule (§2.5) and quiet hours (§2.5 override floor).
//   3. Vacation forwarding (§2.6 / §7.6) redirects a recipient's OUT-OF-BAND notifications to
//      their backup (single hop, bounded), recording a `forwarded` row for the original.

import type {
  AlertCategory,
  AlertSeverity,
  NotificationChannel,
} from "../interfaces/kinds";
import {
  FLOOR_CHANNEL,
  isVacationActive,
  preferredOutOfBandChannels,
  suppressedByQuietHours,
  type RecipientPreferences,
} from "./preferences";

/** The immutable alert facts every delivery row denormalizes (§3.6 M36-F06d): category +
 *  severity are copied onto `notification_delivery` so the voice-SOS-only CHECK is local. */
export interface AlertContext {
  readonly eventType: string;
  readonly category: AlertCategory;
  readonly severity: AlertSeverity;
}

/** A planned `notification_delivery` row (§3.6) before persistence/dispatch. */
export interface PlannedDelivery {
  /** The user this row is delivered to — the backup when `forwardedFromUserId` is set. */
  readonly recipientUserId: string;
  /** The original recipient when this row exists only because they're on vacation (§2.6); else null. */
  readonly forwardedFromUserId: string | null;
  readonly channel: NotificationChannel;
  /** Initial §2.4.4 state. The planner only ever emits these three; vendor callbacks drive the rest. */
  readonly status: "pending" | "skipped_quiet_hours" | "forwarded";
  // Denormalized alert facts (§3.6 M36-F06d) — immutable on the row.
  readonly alertCategory: AlertCategory;
  readonly alertSeverity: AlertSeverity;
}

export interface FanOutInput {
  readonly alert: AlertContext;
  /** `alert_rule.channels_override` (§3.6): when non-null it REPLACES the recipient's routing
   *  map for out-of-band channels (the in-app floor is still added). Null → use preferences. */
  readonly channelsOverride: readonly NotificationChannel[] | null;
  /** Resolved recipient user_ids in fan-out order (output of {@link resolveRecipients}). */
  readonly recipientUserIds: readonly string[];
  /** Preferences by user id — for recipients AND any vacation backups they forward to. */
  readonly preferences: ReadonlyMap<string, RecipientPreferences>;
  /** Evaluation time (quiet-hours / vacation are time-relative). Explicit for determinism. */
  readonly at: Date;
}

/** The voice channel is SOS-only (§2.5): permitted solely for a critical field-safety alert. */
function voiceAllowed(alert: AlertContext): boolean {
  return alert.category === "field_safety" && alert.severity === "critical";
}

/** The out-of-band channel set for a recipient: the rule override if present, else their routing
 *  map (§3.6). In-app is excluded here (the floor is added separately) and voice is dropped unless
 *  the alert qualifies (§2.5). Deduped, order-preserving. */
function outOfBandChannelsFor(
  input: FanOutInput,
  prefs: RecipientPreferences,
): NotificationChannel[] {
  const base =
    input.channelsOverride !== null
      ? input.channelsOverride.filter((c) => c !== FLOOR_CHANNEL)
      : preferredOutOfBandChannels(prefs, input.alert.category, input.alert.severity);

  const allowVoice = voiceAllowed(input.alert);
  const seen = new Set<NotificationChannel>();
  const out: NotificationChannel[] = [];
  for (const ch of base) {
    if (seen.has(ch)) continue;
    if (ch === "voice" && !allowVoice) continue;
    seen.add(ch);
    out.push(ch);
  }
  return out;
}

function denorm(alert: AlertContext) {
  return { alertCategory: alert.category, alertSeverity: alert.severity } as const;
}

/**
 * Plan every `notification_delivery` row for an alert (§2.4.4). For each resolved recipient:
 *   • always an `in_app` row (`pending`) — the floor (§2.1.1), never suppressed/forwarded;
 *   • each out-of-band channel either `pending`, `skipped_quiet_hours` (below the override floor
 *     inside a quiet window, §2.5), or — when the recipient is on vacation (§2.6) — a `forwarded`
 *     row for the original PLUS a `pending`/`skipped_quiet_hours` row for the backup (single hop).
 *
 * A recipient with no preferences entry gets only the in-app floor (safe default: the always-on
 * channel, no out-of-band guesses). Forwarding is bounded to one hop (§7.6): a backup is never
 * itself re-forwarded.
 */
export function planFanOut(input: FanOutInput): PlannedDelivery[] {
  const plan: PlannedDelivery[] = [];
  const d = denorm(input.alert);

  for (const userId of input.recipientUserIds) {
    // 1. The in-app floor — unconditional, to the original recipient.
    plan.push({
      recipientUserId: userId,
      forwardedFromUserId: null,
      channel: FLOOR_CHANNEL,
      status: "pending",
      ...d,
    });

    const prefs = input.preferences.get(userId);
    if (prefs === undefined) continue; // floor-only default

    const channels = outOfBandChannelsFor(input, prefs);
    const onVacation = isVacationActive(prefs, input.at);

    for (const channel of channels) {
      if (onVacation) {
        // Record the original's redirect, then plan the backup's delivery (single hop).
        plan.push({
          recipientUserId: userId,
          forwardedFromUserId: null,
          channel,
          status: "forwarded",
          ...d,
        });
        plan.push(planBackupDelivery(input, prefs, userId, channel, d));
        continue;
      }
      plan.push({
        recipientUserId: userId,
        forwardedFromUserId: null,
        channel,
        status: suppressedByQuietHours(prefs, input.alert.severity, input.at)
          ? "skipped_quiet_hours"
          : "pending",
        ...d,
      });
    }
  }

  return plan;
}

/** The backup's out-of-band delivery when the original is on vacation. The backup's OWN quiet
 *  hours still apply (§2.5); the backup is never re-forwarded (single hop, §7.6). When the backup
 *  has no preferences entry the row defaults to `pending` (best-effort reach). */
function planBackupDelivery(
  input: FanOutInput,
  originalPrefs: RecipientPreferences,
  originalUserId: string,
  channel: NotificationChannel,
  d: { readonly alertCategory: AlertCategory; readonly alertSeverity: AlertSeverity },
): PlannedDelivery {
  const backupUserId = originalPrefs.vacationForwardToUserId as string; // non-null: isVacationActive
  const backupPrefs = input.preferences.get(backupUserId);
  const skipped =
    backupPrefs !== undefined &&
    suppressedByQuietHours(backupPrefs, input.alert.severity, input.at);
  return {
    recipientUserId: backupUserId,
    forwardedFromUserId: originalUserId,
    channel,
    status: skipped ? "skipped_quiet_hours" : "pending",
    ...d,
  };
}
