// M36 ADR-0078 (G-6, G-2) - every word of the two reassign dialogs (the card's "Reassign" and the supervisor's), in one place.
// PROVISIONAL pending clinical-lead review: change the text here, never the codes. A refusal never says WHY a person is
// ineligible. Reassigning does not acknowledge anything, the new person must sign in and take responsibility themselves, and
// messaging is not the emergency path. No patient, message text or id appears here.
import type { AckReasonCode } from "@chartwarden/types";

export const REASSIGN_LABEL = "Reassign";
export const REASSIGN_CONFIRM_LABEL = "Reassign request";
export const REASSIGN_CANCEL_LABEL = "Cancel";
export const REASSIGN_SAVING_TEXT = "Saving...";
export const REASSIGN_COLLEAGUE_FALLBACK = "Colleague";
export const REASSIGN_COLLEAGUE_LEGEND = "Move the request to";
export const REASSIGN_REASON_LEGEND = "Reason (required)";
export const REASSIGN_LOADING_TEXT = "Loading colleagues...";
export const REASSIGN_EMPTY_TEXT = "No one else can take this right now";
export const REASSIGN_LOAD_FAILED_TEXT = "Could not load colleagues.";
export const REASSIGN_RETRY_LABEL = "Retry";

export const REASSIGN_CARD_TITLE = "Reassign this request";
export const REASSIGN_CARD_NOTICE =
  "The person you choose must sign in and take responsibility themselves. Reassigning does not take responsibility for you and is not the emergency path; for critical symptoms follow the agency telephone/emergency procedure.";

export const REASSIGN_SUPERVISOR_TITLE = "Reassign this waiting request";
export const REASSIGN_SUPERVISOR_NOTICE =
  "This moves the request to another person, who must then sign in and take responsibility themselves. It does not acknowledge anything and does not open the conversation. It is not the emergency path; for critical symptoms follow the agency telephone/emergency procedure.";
export const REASSIGN_NEEDS_CHOICE_TEXT = "Choose a reason and a colleague to continue.";
export const REASSIGN_NEEDS_REASON_TEXT = "Choose a reason to continue.";
export const REASSIGN_NEEDS_COLLEAGUE_TEXT = "Choose a colleague to continue.";

export const REASSIGN_REASON_TEXT: Readonly<Record<AckReasonCode, string>> = {
  assignee_unreachable: "The assigned person cannot be reached",
  assignee_unable_to_sign_in: "The assigned person cannot sign in",
  assignee_off_shift: "The assigned person is off shift",
  coverage_change: "Coverage has changed",
  workload: "Workload",
  other_operational: "Another operational reason",
  assignee_left_organisation: "The assigned person has left the organisation",
};

export const REASSIGN_SAVED_CARD_TEXT = "Saved. The request was reassigned.";
export const REASSIGN_SAVED_SUPERVISOR_TEXT =
  "Saved. The request was moved to another person. They still need to take responsibility.";

export const REASSIGN_INDETERMINATE_TEXT = "That may not have been saved. Check the request.";
export const REASSIGN_TOO_MANY_TEXT = "Too many attempts. Wait a moment, then try again.";
export const REASSIGN_SIGN_IN_TEXT = "Your session has ended. Sign in again, then retry.";
export const REASSIGN_NOT_PERMITTED_TEXT = "You are not permitted to do that.";
export const REASSIGN_CHANGED_TEXT = "This request changed. The list has been refreshed.";
export const REASSIGN_CANNOT_TAKE_TEXT = "That person cannot take it. Choose someone else.";
export const REASSIGN_BUSY_TEXT = "Another action is saving. Wait a moment, then try again.";
export const reassignAvailableText = (n: number): string =>
  n === 1 ? "1 colleague available." : `${n} colleagues available.`;
export const REASSIGN_FAILED_TEXT = "That could not be done. Showing the current state.";

export const reassignName = (author: string | undefined, sent: string): string =>
  `${REASSIGN_LABEL} the request for the message${author ? ` from ${author}` : ""} sent ${sent}`;
