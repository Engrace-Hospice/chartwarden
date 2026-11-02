// M36 ADR-0106 (PROPOSED) - emergency message. An author declares a message they posted an EMERGENCY; every other active member of its channel
// is alarmed until they acknowledge, re-alarmed every minute, and the author is told at the 15-minute deadline who has not. Behind the tenant flag
// `messaging.emergency` (absent = off): off is a uniform 404, checked before any request is parsed.

/** The tenant flag that gates every route and the re-alarm sweep. */
export const EMERGENCY_FLAG_KEY = "messaging.emergency";

/** The audience is frozen at send; a channel larger than this is refused (never a silently partial audience). */
export const EMERGENCY_MAX_AUDIENCE = 500;

/** The fixed acknowledgment deadline (ACK_DEADLINE_POLICY.urgent default); the database sets it, a client cannot. */
export const EMERGENCY_DEADLINE_MINUTES = 15;

/** One re-alarm per unacknowledged recipient per tick of this length (the sweep runs every minute). */
export const EMERGENCY_REALARM_INTERVAL_SECONDS = 60;

/** Re-alarming stops this long after the send, whatever happened (the deadline escalation fires long before). */
export const EMERGENCY_REALARM_WINDOW_MINUTES = 60;

/** Emergencies in the sender's own list. */
export const EMERGENCY_LIST_MAX = 50;

/** Outbox/alert event names. The payloads are ids and instants only. */
export const M36_EMERGENCY_SENT = "m36.emergency.sent";
export const M36_EMERGENCY_ESCALATED = "m36.emergency.escalated";

/** The fixed lock-screen/inbox line. It names no channel, patient or sender: details show only after unlock (ADR-0106 D8). */
export const EMERGENCY_ALERT_TEXT = "Emergency message. Open ChartWarden now.";
export const EMERGENCY_ESCALATION_TEXT = "An emergency message has not been acknowledged.";

export interface EmergencyCounts {
  readonly audience: number;
  readonly acknowledged: number;
  readonly pending: number;
}

export interface EmergencySummary {
  readonly emergencyId: string;
  readonly messageId: string;
  readonly channelId: string;
  readonly createdAt: string;
  readonly deadlineAt: string;
  readonly counts: EmergencyCounts;
  /** The deadline passed with somebody still unacknowledged. A marker; the escalation itself is the server's. */
  readonly pastDeadline: boolean;
}

export interface EmergencyPerson {
  readonly userId: string;
  readonly displayName: string;
  readonly acknowledgedAt: string | null;
}

export interface EmergencyCreated extends EmergencySummary {
  /** False when the message already was an emergency (a repeat leaves the audience untouched). */
  readonly created: boolean;
}

export interface EmergencyDetail extends EmergencySummary {
  readonly people: readonly EmergencyPerson[];
}

/** The recipient's own item: waiting (acknowledgedAt null) or done. */
export interface EmergencyMine {
  readonly emergencyId: string;
  readonly messageId: string;
  readonly channelId: string;
  readonly createdAt: string;
  readonly deadlineAt: string;
  readonly acknowledgedAt: string | null;
}

export interface EmergencyAcknowledged {
  readonly emergencyId: string;
  readonly acknowledgedAt: string;
  /** True when it was already acknowledged; the original instant is kept. */
  readonly already: boolean;
}
