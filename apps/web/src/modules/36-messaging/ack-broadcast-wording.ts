// M36 WP 6.8 (ADR-0097) - the acknowledge-required broadcast screen's words. Every state is said in words; opening is never acknowledging.
import type { AckBroadcastFilter, AckBroadcastState } from "@chartwarden/types";

export const BROADCAST_TITLE = "Announcements to acknowledge";
export const BROADCAST_BREADCRUMB = "Messaging";
export const BROADCAST_NOTICE =
  "Opening an announcement does not acknowledge it. Select Acknowledge yourself once you have read it; nobody can acknowledge for you.";
export const BROADCAST_OFF_TITLE = "Acknowledge-required announcements are not turned on";
export const BROADCAST_OFF_TEXT = "Ask your administrator to turn them on. Your announcements are unchanged.";
export const BROADCAST_LOAD_FAILED = "The list could not be loaded. What is waiting on you is not shown.";
export const BROADCAST_DENIED = "You do not have access to this screen.";
export const BROADCAST_RETRY = "Try again";
export const MINE_HEADING = "Waiting for your acknowledgment";
export const MINE_EMPTY_TITLE = "Nothing is waiting on you";
export const MINE_EMPTY_TEXT = "You have acknowledged every announcement that asked for it.";
export const DONE_HEADING = "Acknowledged";
export const OPEN_LABEL = "Open announcement";
export const ACK_LABEL = "Acknowledge";
export const ACKNOWLEDGED_ANNOUNCEMENT = "Acknowledged.";
export const ACK_REFRESH_FAILED = "The list could not be refreshed. What is shown may be out of date.";
export const LOAD_MORE_FAILED = "The next people could not be loaded. The ones already shown are kept.";
export const ACK_FAILED = "Your acknowledgment could not be recorded. Try again.";
export const SUPERVISE_HEADING = "Announcements you oversee";
export const SUPERVISE_EMPTY = "No announcement has required acknowledgment yet.";
export const DETAIL_LOAD_FAILED = "This announcement's list could not be loaded.";
export const LOAD_MORE = "Show more";
export const REQUIRE_LABEL = "Require acknowledgment";
export const REQUIRE_DONE = "Acknowledgment is now required. Track it under Announcements to acknowledge.";
export const REQUIRE_OFF =
  "Acknowledge-required announcements are not turned on for your organization, or only the author of this announcement can require acknowledgment.";
export const REQUIRE_SECTION = "Acknowledgment setting";
export const REQUIRE_FAILED = "Acknowledgment could not be required because of a problem on our side or your connection. Try again.";
export const REQUIRE_HINT =
  "Everyone active today will be asked to acknowledge. The list is fixed now; people who join later are counted but not asked.";

export const FILTER_LABELS: Readonly<Record<AckBroadcastFilter, string>> = {
  pending: "Not acknowledged",
  acknowledged: "Acknowledged",
  ineligible: "No longer active",
  all: "Everyone",
};

export const STATE_LABELS: Readonly<Record<AckBroadcastState, string>> = {
  acknowledged: "Acknowledged",
  opened: "Opened, not acknowledged",
  not_opened: "Not opened",
  ineligible: "No longer active",
};

export const sentLabel = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "Announcement"
    : `Announcement of ${date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
};
export const progressLabel = (acknowledged: number, audience: number): string =>
  `${acknowledged} of ${audience} acknowledged`;
export const OUTSIDE_NOTE = (n: number): string =>
  `${n} ${n === 1 ? "person" : "people"} joined after this was sent and ${n === 1 ? "was" : "were"} not asked.`;
