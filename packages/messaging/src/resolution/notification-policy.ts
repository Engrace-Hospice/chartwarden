// @wardenx/messaging — the notification policy (M36 WP 4.6, ADR-0073).
//
// Pure: no I/O, no clock (the evaluation instant is an argument). It decides, for ONE recipient and ONE alert, which
// out-of-band channels are planned, which are suppressed and why. It sits on top of the M20-era engine in ./preferences and
// ./fan-out and REUSES its quiet-hours test (`isWithinQuietHours`); it adds three things:
//
//   1. DESIGNATED safety-critical routes (the alerts that tell an assignee about an urgent / acknowledgment-bound clinical
//      message). For these the PLATFORM FLOOR applies: the urgency class fixes a minimum set of channels, and nothing the
//      recipient or the tenant configures can remove one, delay one or suppress one. Quiet hours and (future) shift data are
//      recorded as "bypassed" and never act. User preferences and a rule's `channels_override` can only ADD channels.
//   2. VERIFIED ENDPOINTS ONLY: a channel is planned only when the recipient has a verified endpoint on it. A channel with
//      none is omitted and the omission is explained; it is never planned just to fail later.
//   3. SHIFT AWARENESS for everything that is NOT designated: an off-shift recipient is treated as inside quiet hours (same
//      severity override). Shift state is "unknown" unless a seam answers; unknown NEVER suppresses (fail-safe = deliver).
//
// TIGHTEN-ONLY, stated once: every input other than the platform table can only add a channel or add a suppression to a
// NON-designated route. The result for a designated route is a superset of `PLATFORM_CHANNEL_FLOOR[class]` restricted to
// verified channels, for every possible preference, rule override and clock (property-tested).
import type { AlertCategory, AlertSeverity, NotificationChannel } from "../interfaces/kinds";
import {
  FLOOR_CHANNEL,
  type RecipientPreferences,
  isWithinQuietHours,
  severityAtLeast,
} from "./preferences";

/** The acknowledgment classes (ADR-0069). Mirrors `AckClass` in @wardenx/types; this package has no import edge to it. */
export type PolicyAckClass = "important" | "urgent" | "critical";

/** Shift state of a recipient at the instant. `unknown` is the only value any seam can give today (M19's router is a deny-stub). */
export type ShiftState = "on_shift" | "off_shift" | "unknown";

/** Why a channel was planned, suppressed or left out. Codes only: they go on an alert payload and a delivery row, never PHI. */
export type PolicyReason =
  | "designated_floor"
  | "designated_added"
  | "quiet_hours_bypassed"
  | "off_shift_bypassed"
  | "no_verified_endpoint"
  | "quiet_hours"
  | "off_shift"
  | "class_unreadable_defaulted";

/**
 * The alerts that are DESIGNATED safety-critical routes: the ones that tell an ASSIGNEE about an urgent or acknowledgment-bound
 * request. Platform constant, not data: no tenant row can add to it or take from it. The sender's and the supervisors' alerts are
 * deliberately not here (WP 4.5 does not count them as routes either). Pinned to the event constants by a backend test.
 */
export const DESIGNATED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "m36.message.urgent_sent",
  "m36.ack.requested",
  "m36.ack.reassigned",
  "m36.ack.escalated",
]);

/**
 * The platform floor: the out-of-band channels a designated alert MUST be planned on (when the recipient has a verified endpoint
 * there). PROVISIONAL numbers for the clinical lead (brief section 8): important = push; urgent = push (the SMS "after 5 minutes
 * unopened" step of the brief needs a timer and is deferred, ADR-0073); critical = push + SMS at once. Voice stays SOS-only.
 */
export const PLATFORM_CHANNEL_FLOOR: Readonly<
  Record<PolicyAckClass, readonly NotificationChannel[]>
> = Object.freeze({
  important: Object.freeze(["push"] as const),
  urgent: Object.freeze(["push"] as const),
  critical: Object.freeze(["push", "sms"] as const),
});

/** What an unreadable class falls back to: never weaker than urgent. */
const DEFAULT_CLASS: PolicyAckClass = "urgent";

const CLASSES: ReadonlySet<string> = new Set(["important", "urgent", "critical"]);

/**
 * The designated class of an alert, or null when the alert is not a designated route. A designated alert whose payload carries no
 * readable class is NOT downgraded to "not designated": it takes the default class and says so.
 */
export function designatedClassOf(
  eventType: string,
  payload: Record<string, unknown>,
): { readonly ackClass: PolicyAckClass; readonly defaulted: boolean } | null {
  if (!DESIGNATED_EVENT_TYPES.has(eventType)) return null;
  if (eventType === "m36.message.urgent_sent") return { ackClass: "urgent", defaulted: false };
  const raw = payload.ackClass;
  if (typeof raw === "string" && CLASSES.has(raw)) {
    return { ackClass: raw as PolicyAckClass, defaulted: false };
  }
  return { ackClass: DEFAULT_CLASS, defaulted: true };
}

export interface PolicyInput {
  readonly category: AlertCategory;
  readonly severity: AlertSeverity;
  /** Null: not a designated route. */
  readonly ackClass: PolicyAckClass | null;
  /** True when `ackClass` is the default because the payload carried none. */
  readonly classDefaulted?: boolean;
  /** The channels today's engine would use (rule override else routing map), without in_app, voice already gated. */
  readonly baseChannels: readonly NotificationChannel[];
  /** Channels on which the recipient has a verified endpoint (voice rides on `sms`). Undefined = none known. */
  readonly verifiedChannels: ReadonlySet<NotificationChannel> | undefined;
  readonly prefs: RecipientPreferences | undefined;
  readonly shift: ShiftState;
  readonly at: Date;
}

export interface ChannelDecision {
  readonly channel: NotificationChannel;
  /** `planned` = a pending row; `suppressed` = a skipped row; `omitted` = no row (nothing to send to). */
  readonly decision: "planned" | "suppressed" | "omitted";
  readonly reasons: readonly PolicyReason[];
}

function hasVerifiedEndpoint(
  verified: ReadonlySet<NotificationChannel> | undefined,
  channel: NotificationChannel,
): boolean {
  if (verified === undefined) return false;
  return verified.has(channel === "voice" ? "sms" : channel);
}

/** Inside the recipient's quiet hours, or (a known) off shift. `reason` says which; shift never counts when unknown. */
function quietNow(input: PolicyInput): "quiet_hours" | "off_shift" | null {
  if (input.prefs !== undefined && isWithinQuietHours(input.prefs.quietHours, input.at)) {
    return "quiet_hours";
  }
  return input.shift === "off_shift" ? "off_shift" : null;
}

function designatedDecisions(input: PolicyInput, ackClass: PolicyAckClass): ChannelDecision[] {
  const floor = PLATFORM_CHANNEL_FLOOR[ackClass];
  const added = input.baseChannels.filter((c) => c !== FLOOR_CHANNEL && !floor.includes(c));
  const bypassed: PolicyReason[] = [];
  const quiet = quietNow(input);
  if (quiet === "quiet_hours") bypassed.push("quiet_hours_bypassed");
  if (quiet === "off_shift") bypassed.push("off_shift_bypassed");
  if (input.classDefaulted) bypassed.push("class_unreadable_defaulted");

  const decide = (channel: NotificationChannel, why: PolicyReason): ChannelDecision =>
    hasVerifiedEndpoint(input.verifiedChannels, channel)
      ? { channel, decision: "planned", reasons: [why, ...bypassed] }
      : { channel, decision: "omitted", reasons: [why, "no_verified_endpoint"] };

  return [
    ...floor.map((c) => decide(c, "designated_floor")),
    ...added.map((c) => decide(c, "designated_added")),
  ];
}

function ordinaryDecisions(input: PolicyInput): ChannelDecision[] {
  const quiet = quietNow(input);
  // The recipient's own severity override still lets an at/above-floor alert through (§2.5), exactly as before.
  const overridden =
    input.prefs !== undefined &&
    severityAtLeast(input.severity, input.prefs.quietHours.severityOverride);
  const suppressed = quiet !== null && !overridden;
  return input.baseChannels
    .filter((c) => c !== FLOOR_CHANNEL)
    .map((channel) =>
      suppressed && quiet !== null
        ? { channel, decision: "suppressed" as const, reasons: [quiet] }
        : { channel, decision: "planned" as const, reasons: [] },
    );
}

/** Decide every out-of-band channel for one recipient and one alert. Deduplicated, order-preserving, in_app never appears. */
export function decideChannels(input: PolicyInput): ChannelDecision[] {
  const raw =
    input.ackClass === null ? ordinaryDecisions(input) : designatedDecisions(input, input.ackClass);
  const seen = new Set<NotificationChannel>();
  return raw.filter((d) => {
    if (seen.has(d.channel)) return false;
    seen.add(d.channel);
    return true;
  });
}
