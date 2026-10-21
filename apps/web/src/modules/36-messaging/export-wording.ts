// M36 WP 5.7 (ADR-0089, PROPOSED) - every word the restricted messaging export screens show. PROVISIONAL pending compliance sign-off. Plain words, and
// no claim the backend does not make. A refusal (404) never says why. Justifications and notes are staff free text and are only ever rendered as text.
import {
  EXPORT_ALREADY_DECIDED_CODE,
  EXPORT_EXPIRED_CODE,
  EXPORT_LIMIT_CODE,
  EXPORT_NOT_READY_CODE,
  EXPORT_TOO_LARGE_CODE,
  MESSAGING_EXPORT_APPROVE_PERMISSION,
  MESSAGING_EXPORT_DECISION_NOTE_MAX,
  MESSAGING_EXPORT_DOWNLOAD_PERMISSION,
  MESSAGING_EXPORT_JUSTIFICATION_MAX,
  MESSAGING_EXPORT_JUSTIFICATION_MIN,
  MESSAGING_EXPORT_REQUEST_PERMISSION,
  type MessagingExportStatus,
} from "@chartwarden/types";

export const REQUEST_PERMISSION = MESSAGING_EXPORT_REQUEST_PERMISSION;
export const APPROVE_PERMISSION = MESSAGING_EXPORT_APPROVE_PERMISSION;
export const DOWNLOAD_PERMISSION = MESSAGING_EXPORT_DOWNLOAD_PERMISSION;

export const MINE_TITLE = "Message exports";
export const BREADCRUMB = "Messaging";
export const MINE_NOTICE =
  "Ask for a copy of one conversation or one patient's messages. A second person must approve the request before anything is built.";
export const REQUEST_BUTTON = "Request an export";
export const REQUEST_TITLE = "Request a message export";
export const LIST_LABEL = "My exports";
export const EMPTY_TITLE = "No exports yet";
export const EMPTY_TEXT = "Exports you request will appear here.";
export const LOAD_FAILED = "Could not load the exports.";
export const RETRY_LABEL = "Retry";

export const NOT_EXPORTED_HEADING = "What an export leaves out";
export const NOT_EXPORTED_ITEMS: readonly string[] = [
  "Messages under a legal hold are left out. The file says how many.",
  "Messages with substance use (Part 2) content are left out. The file says how many.",
  "Content that is not linked to a patient record (for example a name typed without a link) cannot be detected, so it is not left out.",
  "Attachments are metadata only (name and size). The files themselves are not included.",
  "A second person must approve the request. You cannot approve your own.",
  "After the file is ready, the download link works for 24 hours, then it expires.",
];

export const SCOPE_LEGEND = "What to export";
export const SCOPE_CHANNEL = "One channel";
export const SCOPE_PATIENT = "One patient";
export const CHANNEL_ID_LABEL = "Channel ID";
export const PATIENT_ID_LABEL = "Patient ID";
export const ID_HINT = "Paste the ID. An export covers one channel or one patient, never both.";
export const ID_INVALID = "Enter a valid ID.";
export const DATE_FROM_LABEL = "From (optional)";
export const DATE_TO_LABEL = "To (optional)";
export const DATES_BOTH = "Give both dates, or leave both empty.";
export const DATES_ORDER = "The end date must not be before the start date.";
export const datesTooLong = (days: number): string => `The date range can be at most ${days} days.`;
export const JUSTIFICATION_LABEL = "Justification";
export const JUSTIFICATION_HINT = "Say why you need this export. The approver reads it.";
export const justificationCount = (n: number, min: number, max: number): string =>
  `${n} of ${max} characters (at least ${min})`;
export const JUSTIFICATION_INVALID = `Write a justification of ${MESSAGING_EXPORT_JUSTIFICATION_MIN} to ${MESSAGING_EXPORT_JUSTIFICATION_MAX} characters.`;
export const INVALID_TEXT = "Check the details and try again.";
export const SUBMIT_LABEL = "Send for approval";
export const CANCEL_DIALOG_LABEL = "Close";
export const OFFLINE_TEXT = "You are offline. An export cannot be requested until you reconnect.";
export const REQUESTED = "Export requested. It is waiting for a second person to approve it.";

export const STEP_UP_TEXT =
  "A recent second-factor check is required. Verify with your authenticator, then try again.";
export const SIGN_IN = "Your session has ended. Sign in again to continue.";
export const DENIED = "You are not permitted to do this.";
export const NOT_AVAILABLE = "Exports are not available.";
export const REQUEST_FAILED = "The export could not be requested. Try again.";
export const LIMIT_TEXT = "You have reached the limit for exports. Try again later.";
export const TOO_LARGE_TEXT = "That scope holds too many messages. Narrow the scope or the dates.";
export const ACTION_FAILED = "That did not work. Try again.";

export const STATUS_LABELS: Readonly<Record<MessagingExportStatus, string>> = {
  pending_approval: "Pending approval",
  approved: "Approved",
  building: "Building",
  ready: "Ready",
  failed: "Failed",
  expired: "Expired",
  rejected: "Rejected",
  cancelled: "Cancelled",
};
export const EXPIRED_LABEL = "Expired";
export const expiresIn = (hours: number, minutes: number): string =>
  hours > 0 ? `Expires in ${hours} h ${minutes} min` : `Expires in ${minutes} min`;
export const FAILED_TEXT = "The export could not be built. Request it again.";

export const CANCEL_LABEL = "Cancel request";
export const CANCELLING = "Cancelling…";
export const DOWNLOAD_LABEL = "Download";
export const DOWNLOADING = "Downloading…";
export const DOWNLOAD_NOT_PERMITTED = "You cannot download this export.";
export const DOWNLOAD_STARTED = "The download has started.";
export const NOT_READY_TEXT = "The file is not ready yet.";
export const LINK_EXPIRED_TEXT = "The download link has expired. Request the export again.";
export const ALREADY_DECIDED_TEXT = "This request has already been decided or cancelled.";

export const scopeText = (kind: "channel" | "patient"): string =>
  kind === "channel" ? "Channel" : "Patient";
export const rangeText = (from: string | null, to: string | null): string =>
  from && to ? `${from} to ${to}` : "All dates";
export const countsText = (n: number | null, held: number | null, part2: number | null): string =>
  n === null
    ? ""
    : `${n} messages · ${held ?? 0} held back (legal hold) · ${part2 ?? 0} held back (Part 2)`;

// ── approver queue ────────────────────────────────────────────────────────────────────────────────────────────────────────
export const APPROVALS_TITLE = "Export approvals";
export const APPROVALS_NOTICE =
  "Review each request. You see who asked, what and when, and why. You never see message content here, and you cannot approve your own request.";
export const APPROVALS_LABEL = "Export requests waiting for approval";
export const APPROVALS_EMPTY_TITLE = "Nothing waiting";
export const APPROVALS_EMPTY_TEXT = "No export requests are waiting for approval.";
export const APPROVALS_DENIED = "You are not permitted to approve exports.";
export const OPEN_LABEL = "Review";
export const BACK_LABEL = "Back to the list";
export const DETAIL_TITLE = "Export request";
export const REQUESTER_LABEL = "Requested by";
export const REQUESTED_AT_LABEL = "Requested";
export const justificationHeading = "Justification";
export const DECISION_NOTE_LABEL = "Note";
export const DECISION_NOTE_HINT = "Required when you reject. Optional when you approve.";
export const NOTE_REQUIRED = "Write a note to reject this request.";
export const NOTE_TOO_LONG = `The note can be at most ${MESSAGING_EXPORT_DECISION_NOTE_MAX} characters.`;
export const APPROVE_LABEL = "Approve";
export const REJECT_LABEL = "Reject";
export const OWN_REQUEST = "This is your own request. Someone else has to decide it.";
export const APPROVED_DONE = "Approved. The export will now be built.";
export const REJECTED_DONE = "Rejected.";
export const DECIDED_NOTE_LABEL = "Decision note";

export const conflictText = (code: string | undefined): string => {
  switch (code) {
    case EXPORT_ALREADY_DECIDED_CODE:
      return ALREADY_DECIDED_TEXT;
    case EXPORT_NOT_READY_CODE:
      return NOT_READY_TEXT;
    case EXPORT_EXPIRED_CODE:
      return LINK_EXPIRED_TEXT;
    case EXPORT_TOO_LARGE_CODE:
      return TOO_LARGE_TEXT;
    case EXPORT_LIMIT_CODE:
      return LIMIT_TEXT;
    default:
      return ACTION_FAILED;
  }
};
