// apps/backend/src/modules/36-messaging/ack-delivery-failure/route-rules.ts - WP 4.5 (ADR-0071): the two constants the route reader, the
// consumer and the service must agree on.
import {
  M36_ACK_ESCALATED,
  M36_ACK_REASSIGNED,
  M36_ACK_REQUESTED,
} from "../ack-requests/ack-events";
import { M36_URGENT_MESSAGE_SENT } from "../urgent/urgent-events";

/** The alerts that tell the ASSIGNEE of a request that it needs them: only their routes count (a reminder or the supervisors' alert does not). */
export const ACK_ASSIGNEE_ALERT_EVENT_TYPES: ReadonlySet<string> = new Set([
  M36_URGENT_MESSAGE_SENT,
  M36_ACK_REQUESTED,
  M36_ACK_REASSIGNED,
  M36_ACK_ESCALATED,
]);

/**
 * An alert is "from before the current window" only when it was created more than this long before the window started: the alert is
 * emitted by an outbox consumer a moment AFTER the transition commits, and the window starts on the database clock, so a small skew
 * must not make a current alert look stale.
 */
export const WINDOW_ALERT_TOLERANCE_MS = 5_000;
