// apps/backend/src/modules/36-messaging/emergency/emergency-alert.ts - ADR-0106: the ONE place the emergency alert is built, shared by the
// outbox consumer (the first alarm, tick 0) and the re-alarm sweep (tick n = whole minutes since the send). The alert id converges on
// `(organization, correlationId)`, so a redelivered event or a second sweep worker in the same minute raises nothing twice.
// The text is fixed and names no channel, patient or sender (ADR-0106 D8); the deep link opens only inside an authenticated session.
import {
  EMERGENCY_ALERT_TEXT,
  EMERGENCY_ESCALATION_TEXT,
  EMERGENCY_REALARM_INTERVAL_SECONDS,
  M36_EMERGENCY_ESCALATED,
  M36_EMERGENCY_SENT,
} from "@chartwarden/types";

export interface EmergencyAlertInput {
  readonly eventType: string;
  readonly severity: "critical";
  readonly correlationId: string;
  readonly payload: Record<string, unknown>;
}

const deepLink = (channelId: string, messageId: string, emergencyId: string): string =>
  `/messaging?channelId=${encodeURIComponent(channelId)}&messageId=${encodeURIComponent(messageId)}&emergencyId=${encodeURIComponent(emergencyId)}`;

/** Whole re-alarm intervals since the send (pure). 0 is the first alarm. */
export function alarmTick(createdAt: Date, now: Date): number {
  return Math.max(
    0,
    Math.floor((now.getTime() - createdAt.getTime()) / (EMERGENCY_REALARM_INTERVAL_SECONDS * 1000)),
  );
}

/** The alarm for one recipient at one tick. */
export function emergencyAlarm(f: {
  readonly emergencyId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly recipientUserId: string;
  readonly tick: number;
}): EmergencyAlertInput {
  return {
    eventType: M36_EMERGENCY_SENT,
    severity: "critical",
    correlationId: `emergency:${f.emergencyId}:${f.recipientUserId}:${f.tick}`,
    payload: {
      recipientUserId: f.recipientUserId,
      emergencyId: f.emergencyId,
      channelId: f.channelId,
      messageId: f.messageId,
      repeat: f.tick,
      // The message the alert is ABOUT (read back by `m36.notification.delivery_failed`, WP 4.5).
      sourceAggregateId: f.messageId,
      message: EMERGENCY_ALERT_TEXT,
      deepLink: deepLink(f.channelId, f.messageId, f.emergencyId),
    },
  };
}

/** The deadline escalation: ONE alert per emergency, to the sender and the supervisors (rule `m36.emergency.escalated`). */
export function emergencyEscalation(f: {
  readonly emergencyId: string;
  readonly channelId: string;
  readonly messageId: string;
  readonly authorUserId: string;
  readonly pending: number;
}): EmergencyAlertInput {
  return {
    eventType: M36_EMERGENCY_ESCALATED,
    severity: "critical",
    correlationId: `emergency-escalated:${f.emergencyId}`,
    payload: {
      authorUserId: f.authorUserId,
      emergencyId: f.emergencyId,
      channelId: f.channelId,
      messageId: f.messageId,
      pending: f.pending,
      sourceAggregateId: f.messageId,
      message: EMERGENCY_ESCALATION_TEXT,
      deepLink: deepLink(f.channelId, f.messageId, f.emergencyId),
    },
  };
}
