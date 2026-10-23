// M36 WP 6.1 (ADR-0091) - the smart work inbox's words. Every state is said in words; a quiet list is never shown for a broken read.
import type { SmartInboxBand } from "@chartwarden/types";

export const INBOX_TITLE = "Work inbox";
export const INBOX_BREADCRUMB = "Messaging";
export const INBOX_NOTICE =
  "Your own waiting work in one list. Urgent requests are always first and are never hidden. Each row says why it is where it is; nothing here is acted on until you open it.";
export const INBOX_OFF_TITLE = "The work inbox is not turned on";
export const INBOX_OFF_TEXT = "Ask your administrator to turn it on. Your messages and tasks are unchanged.";
export const INBOX_EMPTY_TITLE = "Nothing is waiting on you";
export const INBOX_EMPTY_TEXT =
  "No acknowledgment requests, handoffs, tasks, mentions or unread care-team messages.";
export const INBOX_LOAD_FAILED = "The inbox could not be loaded. What is waiting on you is not shown.";
export const INBOX_STALE = "The inbox could not be refreshed and may be out of date.";
export const INBOX_DENIED = "You do not have access to the work inbox.";
export const INBOX_SIGN_IN = "Your session has ended. Sign in again.";
export const INBOX_RETRY_LABEL = "Try again";
export const INBOX_URGENT_INCOMPLETE =
  "More urgent requests may exist than are shown here. Open the acknowledgment queue to see them all.";
export const INBOX_INCOMPLETE = "Only the most pressing rows are shown.";
export const INBOX_OPEN_LABEL = "Open in Messaging";
export const RANK_LABEL = "Rank";
export const REASON_URGENT = "Urgent";
export const REASON_WHY = "Why here";
export const INBOX_RESTRICTED = "You cannot open this conversation. Ask the sender or a supervisor.";

export const BAND_LABELS: Readonly<Record<SmartInboxBand, string>> = {
  urgent_ack: "Urgent: needs your acknowledgment",
  handoff_awaiting: "Handoffs awaiting your answer",
  task_assigned: "Tasks assigned to you",
  mention: "Mentions",
  care_team_unread: "Unread care-team messages",
};

export const SOURCE_UNAVAILABLE = (band: SmartInboxBand): string =>
  `${BAND_LABELS[band]} could not be read; that part of the list is missing.`;
