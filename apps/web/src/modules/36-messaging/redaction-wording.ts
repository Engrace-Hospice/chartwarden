// M36 WP 5.6 (ADR-0055 item 7, ADR-0086, PROPOSED) - the words of the Redactions tab. A redaction MASKS a message for every reader; it never destroys
// the message, so a legal hold does not block it. State is always a word. The single-officer fallback is PROVISIONAL (compliance has not signed it
// off) and is worded loudly on purpose.
import type { MessageRedactionDto } from "@chartwarden/types";

export const TAB_REDACTIONS = "Redactions";
export const REDACTIONS_INTRO =
  "Redaction hides a message's text, attachments and links from everyone. It does not delete the message: the original is kept, and a legal hold does not stop it. Two different people are needed: one asks, another approves.";
export const REDACTIONS_LIST_LABEL = "Redaction requests";
export const REDACTIONS_EMPTY_TITLE = "No redaction requests";
export const REDACTIONS_EMPTY_TEXT =
  "Nothing has been asked to be redacted. Request a redaction to start.";
export const REQUEST_LABEL = "Request redaction";
export const LOAD_FAILED_REDACTIONS = "The redaction list could not be loaded.";

export const STATUS: Readonly<
  Record<
    MessageRedactionDto["status"],
    {
      label: string;
      tone: "progress" | "warning" | "success" | "error";
      glyph: "clock" | "check-circle" | "block" | "dot";
    }
  >
> = {
  requested: { label: "Waiting for approval", tone: "progress", glyph: "clock" },
  awaiting_countersign: { label: "Waiting for countersign", tone: "warning", glyph: "clock" },
  approved: { label: "Redacted", tone: "success", glyph: "check-circle" },
  lapsed: { label: "Countersign lapsed", tone: "error", glyph: "block" },
};
export const STATUS_NOTE: Readonly<Record<MessageRedactionDto["status"], string>> = {
  requested:
    "The message is out of search and cannot be edited. Its text is still visible until it is approved.",
  awaiting_countersign:
    "Approved by the requester alone. The message is NOT redacted yet: a second role must countersign before the deadline.",
  approved: "The message is hidden for every reader.",
  lapsed:
    "The countersign period passed, so the message is NOT redacted. A different officer can still approve it.",
};
export const UNDER_HOLD = "Under legal hold: the original is kept either way";
export const requestedText = (by: string, at: string): string => `Requested by ${by} on ${at}`;
export const approvedText = (by: string, at: string): string => `Approved by ${by} on ${at}`;
export const countersignedText = (by: string): string => `Countersigned by ${by}`;
export const deadlineText = (at: string): string => `Countersign by ${at}`;
export const SELF_APPROVED_TEXT =
  "Approved by the requester as the only eligible officer (provisional)";
export const messageText = (id: string): string => `Message ${id}`;
export const shortId = (id: string): string => `user ${id.slice(0, 8)}`;
export const YOU = "you";

// Actions
export const APPROVE_LABEL = "Approve";
export const COUNTERSIGN_LABEL = "Countersign";
export const SELF_APPROVE_LABEL = "Approve as the only officer";
export const actionLabel = (verb: string, id: string): string =>
  `${verb} redaction of message ${id}`;
export const CANCEL_LABEL = "Cancel";

// Request dialog
export const REQUEST_TITLE = "Request a redaction";
export const REQUEST_DETAIL =
  "You will not see the message. Name it by its id; a different officer approves. Until then the message stays visible but leaves search and cannot be edited.";
export const MESSAGE_ID_LABEL = "Message id";
export const REASON_LABEL = "Reason";
export const REASON_HINT =
  "10 to 1000 characters. Do not include patient names or identifiers; the reason is stored.";
export const MESSAGE_ID_INVALID = "Enter the message id as a valid id.";
export const REASON_SHORT = "The reason must be 10 to 1000 characters.";
export const REQUEST_ACTION = "Send request";
export const REQUEST_FAILED = "The request could not be sent. Nothing was changed; try again.";
export const REQUEST_EXISTS = "This message already has a redaction request.";
export const REQUEST_NOT_FOUND = "No message with that id was found.";
export const REQUEST_ANNOUNCEMENT = "Redaction requested.";

// Decision dialogs
export const APPROVE_TITLE = "Approve redaction";
export const APPROVE_DETAIL =
  "Approving hides the message for every reader. You cannot approve a request you made yourself. You will be asked to confirm your identity again.";
export const COUNTERSIGN_TITLE = "Countersign redaction";
export const COUNTERSIGN_DETAIL =
  "The requester approved this alone. Countersigning makes the redaction final and hides the message for every reader. You cannot countersign your own request. You will be asked to confirm your identity again.";
export const SELF_TITLE = "Approve as the only officer (provisional)";
export const SELF_DETAIL =
  "You are the only person who can approve redactions here. This is a provisional exception that compliance has not signed off. Your approval hides NOTHING by itself: a second role (an organization admin or the privacy officer) must countersign within 72 hours, or the redaction stays undone. Both steps are recorded in the audit trail.";
export const SELF_CONFIRM =
  "I understand this is provisional and needs a countersign within 72 hours";
export const CONFIRM_APPROVE = "Approve now";
export const CONFIRM_COUNTERSIGN = "Countersign now";
export const CONFIRM_SELF = "Approve my own request";
export const STEP_UP_TEXT = "Confirming your identity is required before this can be done.";
export const DECISION_FAILED = "That could not be done. Nothing was changed; try again.";
export const NOT_AVAILABLE = "That is no longer possible for this request. The list was refreshed.";
export const LAPSED_ERROR = "The countersign period has passed. The redaction was not made final.";
export const SAME_PERSON = "A different person than the requester must do this.";
export const APPROVED_ANNOUNCEMENT = "Redaction approved.";
export const SELF_ANNOUNCEMENT = "Approved as the only officer. Waiting for a countersign.";
export const COUNTERSIGNED_ANNOUNCEMENT = "Redaction countersigned and final.";
export const deniedText = (code: 401 | 403): string =>
  code === 401 ? "Your session has ended. Sign in again." : "You are not permitted to do that.";
