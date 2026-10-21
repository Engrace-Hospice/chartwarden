// M36 WP 5.8 (ADR-0087, PROPOSED) - every word the break-glass request, banner, read-only conversation and review screen show. PROVISIONAL pending
// compliance sign-off. A refusal never says why (it would disclose a Part 2 status or a role category). Justifications and notes are free text
// written by staff and are only ever rendered as text.
import type { BreakGlassReadKind, BreakGlassReasonCode } from "@chartwarden/types";

export const INVOKE_PERMISSION = "messaging.break_glass.invoke";
export const REVIEW_PERMISSION = "messaging.break_glass.review";

export const REQUEST_BUTTON = "Request break-glass access";
export const REQUEST_TITLE = "Request break-glass access";
export const REQUEST_DETAIL =
  "This opens ONE conversation to you for reading only, for a limited time. You cannot send, react or attach. Every read is recorded, and a compliance reviewer will review this afterwards. Use it only when you need the conversation now.";
export const REASON_LABEL = "Reason";
export const JUSTIFICATION_LABEL = "Justification";
export const JUSTIFICATION_HINT =
  "Say what you need and why. Compliance reviewers read this; it is not shown to anyone else.";
export const justificationCount = (n: number, min: number, max: number): string =>
  `${n} of ${max} characters (at least ${min})`;
export const DURATION_LABEL = "Duration";
export const DURATION_CUSTOM = "Custom (minutes)";
export const DURATION_CUSTOM_LABEL = "Minutes (15 to 1440)";
export const SUBMIT_LABEL = "Open access";
export const CANCEL_LABEL = "Cancel";

export const REASON_LABELS: Readonly<Record<BreakGlassReasonCode, string>> = {
  patient_safety: "Patient safety",
  covering_colleague: "Covering a colleague",
  record_correction: "Correcting a record",
  other: "Other",
};
export const DURATION_PRESETS: readonly { readonly minutes: number; readonly label: string }[] = [
  { minutes: 60, label: "1 hour" },
  { minutes: 240, label: "4 hours (default)" },
  { minutes: 720, label: "12 hours" },
  { minutes: 1440, label: "24 hours" },
];

export const JUSTIFICATION_INVALID = "Write a justification of 20 to 280 characters.";
export const DURATION_INVALID = "Choose a duration of 15 minutes to 24 hours.";
export const NOT_AVAILABLE = "Access is not available for this conversation.";
export const STEP_UP_TEXT =
  "A recent second-factor check is required. Verify with your authenticator, then try again.";
export const SIGN_IN = "Your session has ended. Sign in again to continue.";
export const DENIED = "You are not permitted to request break-glass access.";
export const REQUEST_FAILED = "Break-glass access could not be opened. Try again.";
export const OFFLINE_TEXT =
  "You are offline. Break-glass access cannot be requested until you reconnect.";

export const BANNER_ENDS = (time: string): string =>
  `Break-glass access to this conversation ends ${time}. Every read is recorded.`;
export const END_NOW = "End now";
export const ENDING = "Ending…";
export const END_FAILED = "Access could not be ended. Try again.";
export const EXPIRED_NOTICE = "Break-glass access to this conversation has ended.";
export const READ_ONLY_NOTICE =
  "Read-only: break-glass access does not allow sending, reacting or attaching.";
export const CONVERSATION_LOAD_FAILED = "The conversation could not be loaded.";
export const LOAD_OLDER = "Load earlier messages";
export const NO_MESSAGES = "No messages in this conversation.";
export const minutesLeft = (n: number): string =>
  n <= 1 ? "less than a minute left" : `${n} minutes left`;

// ── compliance review screen ────────────────────────────────────────────────────────────────────────────────────────────────
export const REVIEW_TITLE = "Break-glass review";
export const REVIEW_BREADCRUMB = "Admin / Messaging";
export const REVIEW_NOTICE =
  "Every break-glass grant is reviewed. The reads listed are ids and times only, never message text. The due time is one business day after the access ends (a default pending compliance confirmation).";
export const TABS_LABEL = "Review status";
export const TAB_PENDING = "Pending";
export const TAB_REVIEWED = "Reviewed";
export const TAB_ALL = "All";
export const LIST_LABEL = "Break-glass reviews";
export const EMPTY_TITLE = "Nothing to review";
export const EMPTY_TEXT = "No break-glass access in this view.";
export const LOAD_FAILED = "Could not load the reviews.";
export const RETRY_LABEL = "Retry";
export const REVIEW_DENIED = "You are not permitted to review break-glass access.";
export const overdueCount = (n: number): string =>
  n === 1 ? "1 review overdue" : `${n} reviews overdue`;
export const OVERDUE_LABEL = "Overdue";
export const STILL_ACTIVE_LABEL = "Access still open";
export const STATUS_OPEN = "Open";
export const STATUS_REVIEWED = "Reviewed";
export const STATUS_CONCERN = "Concern";
export const OPEN_REVIEW = "Open review";
export const readsText = (n: number): string => (n === 1 ? "1 read" : `${n} reads`);
export const endedText = (when: string): string => `Ended ${when}`;
export const dueText = (when: string): string => `Due ${when}`;
export const holderText = (name: string | null): string => name ?? "A staff member";
export const CHANNEL_CARE_TEAM = "A care-team conversation";

export const DETAIL_TITLE = "Review details";
export const JUSTIFICATION_HEADING = "Justification";
export const READS_HEADING = "Recorded reads";
export const READS_NONE = "No reads were recorded.";
export const READ_KIND_LABELS: Readonly<Record<BreakGlassReadKind, string>> = {
  channel: "Opened the conversation",
  messages: "Read messages",
  thread: "Read a thread",
  attachment: "Opened an attachment",
  search: "Searched",
  ack: "Read a request",
  handoff: "Read a handoff",
  context: "Read patient context",
};
export const readLine = (kind: string, count: number | null): string =>
  count === null ? kind : `${kind} (${count})`;
export const OUTCOME_LABEL = "Outcome";
export const OUTCOME_REVIEWED = "Reviewed, no concern";
export const OUTCOME_CONCERN = "Concern";
export const NOTE_LABEL = "Note";
export const NOTE_HINT =
  "Required for a concern. At most 1000 characters. Not shown outside compliance.";
export const NOTE_REQUIRED = "A concern needs a note saying what it is.";
export const NOTE_TOO_LONG = "The note is at most 1000 characters.";
export const COMPLETE_LABEL = "Complete review";
export const OWN_GRANT = "You held this access, so someone else must review it.";
export const STILL_ACTIVE_TEXT =
  "The access has not ended yet. End it now, or wait for it to expire, then complete the review.";
export const END_ACCESS = "End access now";
export const ALREADY_DONE = "This review was already completed. The list has been refreshed.";
export const COMPLETE_FAILED = "The review could not be completed. Try again.";
export const COMPLETED = "Review completed.";
export const BACK_LABEL = "Back to the list";

// ── review fixes ────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const readsTruncatedText = (shown: number, total: number): string =>
  `Showing the first ${shown} of ${total} reads. The rest are recorded but not listed here.`;
export const LIMIT_TEXT =
  "Too many break-glass requests. End access you no longer need, or try again later.";
export const NOT_NEEDED_TEXT =
  "You can already open this conversation. Refreshing your conversation list.";
export const NOT_PERMITTED = "You are not permitted to complete this review.";
export const PATIENT_LABEL = "Patient";
