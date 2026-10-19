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

import type { AlertCategory, AlertSeverity, NotificationChannel } from "../interfaces/kinds";
import {
  type PolicyAckClass,
  type PolicyReason,
  type ShiftState,
  decideChannels,
} from "./notification-policy";
import {
  FLOOR_CHANNEL,
  type RecipientPreferences,
  isVacationActive,
  preferredOutOfBandChannels,
  suppressedByQuietHours,
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
  /** WP 4.6: the policy reason code of a suppressed row (persisted as `fail_reason`); absent on every other row. */
  readonly reason?: PolicyReason;
}

/** WP 4.6: the notification policy inputs (ADR-0073). Absent = the engine exactly as before. */
export interface FanOutPolicy {
  /** Null = not a designated safety-critical route. */
  readonly ackClass: PolicyAckClass | null;
  readonly classDefaulted?: boolean;
  /** Channels with a verified endpoint, per recipient user id. A user absent from the map has none. */
  readonly verifiedChannels: ReadonlyMap<string, ReadonlySet<NotificationChannel>>;
  /** Shift state per user; absent = `unknown` for everyone (fail-safe: unknown never suppresses). */
  readonly shiftFor?: (userId: string) => ShiftState;
}

/** One explained policy decision (ids and codes only, no PHI) — stored on the alert payload of a designated route. */
export interface PolicyTrailEntry {
  readonly recipientUserId: string;
  readonly channel: NotificationChannel;
  readonly decision: "planned" | "suppressed" | "omitted";
  readonly reasons: readonly PolicyReason[];
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
  readonly policy?: FanOutPolicy;
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
  prefs: RecipientPreferences | undefined,
): NotificationChannel[] {
  const base =
    input.channelsOverride !== null
      ? input.channelsOverride.filter((c) => c !== FLOOR_CHANNEL)
      : prefs === undefined
        ? []
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

/** The planned rows plus the explained policy decisions of a designated route (empty for any other alert). */
export interface FanOutResult {
  readonly plan: PlannedDelivery[];
  readonly trail: PolicyTrailEntry[];
}

/**
 * Plan every `notification_delivery` row for an alert (§2.4.4). For each resolved recipient:
 *   • always an `in_app` row (`pending`) — the floor (§2.1.1), never suppressed/forwarded;
 *   • each out-of-band channel the notification policy (./notification-policy) decides on: `pending`, or
 *     `skipped_quiet_hours` (below the override floor inside a quiet window or off shift, §2.5), or — when the
 *     recipient is on vacation (§2.6) — a `forwarded` row for the original PLUS a `pending`/`skipped_quiet_hours`
 *     row for the backup (single hop). A DESIGNATED safety-critical route (WP 4.6) is never suppressed and never
 *     forwarded: the named assignee is the only target.
 *
 * A recipient with no preferences entry gets only the in-app floor — except on a designated route, where the platform
 * floor applies to their verified endpoints. Forwarding is bounded to one hop (§7.6).
 */
export function planFanOutDetailed(input: FanOutInput): FanOutResult {
  const plan: PlannedDelivery[] = [];
  const trail: PolicyTrailEntry[] = [];
  const d = denorm(input.alert);
  const policy = input.policy;
  const designated = policy !== undefined && policy.ackClass !== null;

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
    if (prefs === undefined && !designated) continue; // floor-only default

    const decisions = decideChannels({
      category: input.alert.category,
      severity: input.alert.severity,
      ackClass: policy?.ackClass ?? null,
      classDefaulted: policy?.classDefaulted ?? false,
      baseChannels: outOfBandChannelsFor(input, prefs),
      verifiedChannels: policy?.verifiedChannels.get(userId),
      prefs,
      shift: policy?.shiftFor?.(userId) ?? "unknown",
      at: input.at,
    });
    const onVacation = !designated && prefs !== undefined && isVacationActive(prefs, input.at);

    for (const { channel, decision, reasons } of decisions) {
      if (designated) {
        trail.push({ recipientUserId: userId, channel, decision, reasons });
        if (decision === "planned") {
          plan.push({
            recipientUserId: userId,
            forwardedFromUserId: null,
            channel,
            status: "pending",
            ...d,
          });
        }
        continue;
      }
      if (onVacation && prefs !== undefined) {
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
        status: decision === "suppressed" ? "skipped_quiet_hours" : "pending",
        ...(decision === "suppressed" ? { reason: reasons[0] ?? ("quiet_hours" as const) } : {}),
        ...d,
      });
    }
  }

  return { plan, trail };
}

/** {@link planFanOutDetailed} without the trail (the M20 engine's original surface). */
export function planFanOut(input: FanOutInput): PlannedDelivery[] {
  return planFanOutDetailed(input).plan;
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
    ...(skipped ? { reason: "quiet_hours" as const } : {}),
    ...d,
  };
}
