// M36 WP 4.9 (ADR-0076) - every word the supervisor's unacknowledged queue shows, in one place. PROVISIONAL pending clinical-lead
// review (brief section 11): change the text here, never the codes. The list is not a page and not the emergency path, it only reads,
// and a filter only narrows what is shown: the total of everything waiting is always stated beside it.
import type { AckClass, AckEscalationNote, AckQueueStatus } from "@chartwarden/types";

export const QUEUE_TITLE = "Unacknowledged urgent requests";
export const QUEUE_BREADCRUMB = "General / Messaging";
export const QUEUE_NOTICE =
  "Every request still waiting for someone to take responsibility. This list does not page anyone and is not the emergency path; for critical symptoms follow the agency telephone procedure. Looking at it changes nothing.";
export const QUEUE_FILTER_NOTE =
  "Filters only narrow what you see. The total of everything waiting is always shown above.";
export const QUEUE_EMPTY_TITLE = "Nothing is waiting for a response";
export const QUEUE_EMPTY_DESCRIPTION =
  "No urgent or important request is waiting for someone to take responsibility.";
export const QUEUE_FILTER_EMPTY_TITLE = "No requests match these filters";
export const QUEUE_SHOW_ALL_LABEL = "Show everything waiting";
export const QUEUE_LOAD_FAILED = "Could not load the list.";
export const QUEUE_STALE = "The list may be out of date: the last refresh failed.";
export const QUEUE_DENIED = "You are not permitted to see this list.";
export const QUEUE_SIGN_IN = "Your session has ended. Sign in again to see this list.";
export const QUEUE_RETRY_LABEL = "Retry";
export const QUEUE_SPAN_CAPPED =
  "The list was refreshed from the top because it had grown very long. Use Show more to load the rest.";
export const QUEUE_MORE_LABEL = "Show more";
export const QUEUE_MORE_FAILED = "Could not load more. Try again.";
export const QUEUE_OPEN_LABEL = "Open the conversation";
export const QUEUE_RESTRICTED_TEXT =
  "You cannot open this conversation, so it is listed without the patient or message. Contact the person it is assigned to.";
export const QUEUE_UNASSIGNED_NAME = "a colleague";
/** ADR-0078 (G-7): the sender, in words, on every row (a restricted row too: the same disclosure as the assignee's name). */
export const QUEUE_SENDER_UNKNOWN = "Sender not available.";
export const queueSenderText = (name: string | null): string =>
  name?.trim() ? `Sent by ${name.trim()}.` : QUEUE_SENDER_UNKNOWN;
/** ADR-0078 (G-2): the supervisor's Reassign button; the dialog's own words are in ack-reassign-wording.ts. */
export const QUEUE_REASSIGN_LABEL = "Reassign";
/** The accessible name starts with the visible text (WCAG 2.5.3) and tells the rows apart: assignee, sender and due time. */
export const queueReassignName = (
  assignee: string,
  sender: string | null,
  dueLabel: string,
): string =>
  `${QUEUE_REASSIGN_LABEL}, assigned to ${assignee}, ${sender?.trim() ? `sent by ${sender.trim()}` : "sender not available"}, ${dueLabel}`;

export const STATUS_FILTERS: readonly { value: AckQueueStatus | "all"; label: string }[] = [
  { value: "all", label: "Everything waiting" },
  { value: "pending", label: "Waiting" },
  { value: "escalated", label: "Escalated" },
  { value: "failed_unreachable", label: "Could not be delivered" },
];
export const OVERDUE_FILTER_LABEL = "Overdue only";

export const QUEUE_STATUS_TEXT: Readonly<Record<AckQueueStatus, string>> = {
  pending: "Waiting",
  escalated: "Escalated",
  failed_unreachable: "Could not be delivered",
};

export const QUEUE_CLASS_TEXT: Readonly<Record<AckClass, string>> = {
  important: "Important",
  urgent: "Urgent",
  critical_symptom: "Critical symptom",
};

export const QUEUE_NOTE_TEXT: Readonly<Record<AckEscalationNote, string>> = {
  route_unavailable: "Past the deadline and it could not be passed to the next person.",
  ladder_exhausted: "Past the deadline and there is no one further to pass it to.",
};

export const QUEUE_UNREACHABLE_TEXT =
  "It could not be delivered by any route outside the app. Nobody is known to have received it.";

function minutesText(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  return `${Math.floor(hours / 24)} d`;
}

export const overdueText = (seconds: number): string => `Overdue by ${minutesText(seconds)}`;

/** "Due in 12 min" from the deadline instant; a past or unparseable one reads as overdue-by-zero, never as a negative. */
export function dueText(deadlineAt: string, now: number): string {
  const ms = Date.parse(deadlineAt) - now;
  return Number.isNaN(ms) || ms <= 0 ? "Due now" : `Due in ${minutesText(ms / 1000)}`;
}

export function summaryText(
  counts: {
    unfiltered: number;
    matching: number;
    overdue: number;
    failed_unreachable: number;
  },
  shown: number,
  filtered: boolean,
): string {
  if (counts.unfiltered === 0) return "Nothing is waiting.";
  const parts = [`${counts.unfiltered} waiting`, `${counts.overdue} overdue`];
  if (counts.failed_unreachable > 0)
    parts.push(`${counts.failed_unreachable} could not be delivered`);
  const shownText = filtered
    ? `Showing ${shown} of ${counts.matching} that match the filters.`
    : `Showing ${shown} of ${counts.unfiltered}.`;
  return `${parts.join(", ")}. ${shownText}`;
}
