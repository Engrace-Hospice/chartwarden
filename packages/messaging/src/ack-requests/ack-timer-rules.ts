// @wardenx/messaging - the pure rules of the WP 4.4 escalation timers (ADR-0070): which window a tier gets, which job id a timer
// carries, and when a request is due. Nothing here reads a clock, a database or a queue.
import { ACK_DEADLINE_POLICY, type AckClass, type AckStatus } from "@wardenx/types";

/**
 * Minutes each router tier (1-based) gets before the next one is asked, per class (plan D4: "each tier gets half the previous
 * window, floor 5 min" for important; urgent 7 then 5; critical 3 then 2). The last entry repeats for every later tier.
 * PROVISIONAL: no clinical-lead sign-off is recorded. Every entry is within the class's platform maximum (a test pins it).
 */
export const ACK_TIER_WINDOW_MINUTES: Readonly<Record<AckClass, readonly number[]>> = {
  important: [30, 15, 7, 5],
  urgent: [7, 5],
  critical_symptom: [3, 2],
};

/** The window a request gets when it is routed to `tier` (0 = the named assignee: the class default). */
export function tierWindowMinutes(ackClass: AckClass, tier: number): number {
  if (!Number.isSafeInteger(tier) || tier < 0)
    throw new RangeError("tier must be a whole number >= 0");
  if (tier === 0) return ACK_DEADLINE_POLICY[ackClass].defaultMinutes;
  const windows = ACK_TIER_WINDOW_MINUTES[ackClass];
  return windows[Math.min(tier, windows.length) - 1] as number;
}

/**
 * The deterministic BullMQ job id of one timer: the request, the tier it waits on and the deadline of THAT window. A duplicate add
 * is a no-op; a reassign (new window, new deadline) arms a new id and the old job finds a different deadline and does nothing.
 * No colon: BullMQ rejects custom ids that contain one.
 */
export function escalationJobId(requestId: string, tier: number, deadlineAt: Date): string {
  return `ack-esc-${requestId}-${tier}-${deadlineAt.getTime()}`;
}

/** A request is due only while nobody has taken it: `pending` or `escalated`, at or past its deadline. */
export function isEscalationDue(status: AckStatus, deadlineAt: Date, now: Date): boolean {
  return (status === "pending" || status === "escalated") && deadlineAt.getTime() <= now.getTime();
}

/** At most one `route_unavailable` / `ladder_exhausted` history row (and one alert) per request per this interval. */
export const ROUTE_UNAVAILABLE_RECORD_INTERVAL_MS = 60 * 60_000;

/** Requests one org sweep handles per tick; the rest wait for the next tick (oldest deadline first). */
export const ESCALATION_SWEEP_BATCH = 500;
