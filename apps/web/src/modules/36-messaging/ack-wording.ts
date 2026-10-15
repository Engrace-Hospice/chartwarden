// M36 WP 4.2 - every word the acknowledgment-request card shows, in one place. PROVISIONAL pending clinical-lead review (no
// sign-off is recorded; see docs/messaging-hub/brief-clinical-lead-signoff.md): change the text here, never the codes.
// Taking responsibility is an explicit action; opening or reading a message never does it, nothing here pages anyone, and
// messaging is not the emergency path. No tenant can remove the notice.
import type { AckStatus } from "@wardenx/types";

export const ACK_NOTICE =
  "Taking responsibility is an explicit action: opening or reading this message does not do it. This does not page anyone and is not the emergency path; for critical symptoms follow the agency telephone/emergency procedure.";
export const ACK_TAKE_LABEL = "Take responsibility";
export const ACK_CLOSE_LABEL = "Close this request";
export const ACK_WORKING_TEXT = "Saving...";
export const ACK_LOAD_FAILED_TEXT = "Could not load requests.";
export const ACK_RETRY_LABEL = "Retry";
export const ACK_INDETERMINATE_TEXT = "That may not have been saved. Check the request below.";
export const ACK_NOT_QUALIFIED_TEXT = "Your role cannot take this message.";
export const ACK_CLOSE_NOT_QUALIFIED_TEXT = "Your role cannot close this message.";
export const ACK_TOO_MANY_TEXT = "Too many attempts. Wait a moment, then try again.";
export const ACK_SIGN_IN_TEXT = "Your session has ended. Sign in again, then retry.";
export const ACK_NOT_PERMITTED_TEXT = "You are not permitted to do that.";
export const ACK_INVALID_TEXT = "That could not be accepted. Reload and try again.";
export const ACK_FAILED_TEXT = "That could not be done. Showing the current state.";
export const ACK_SAVED_TAKEN_TEXT = "Saved. Responsibility taken for this request.";
export const ACK_SAVED_CLOSED_TEXT = "Saved. This request is closed.";
export const ACK_STALE_TEXT = "These requests may be out of date. The latest reload failed.";
export const ACK_SIGN_IN_LOAD_TEXT = "Sign in again to see response requests.";
export const ACK_FORBIDDEN_LOAD_TEXT = "You are not permitted to see response requests here.";
export const ACK_WAIT_LOAD_TEXT = "Too many requests. Wait a moment, then retry.";
export const ACK_CHANGED_TEXT = "This request has changed. Showing its current state.";
export const ACK_GONE_TEXT = "This request is no longer available.";

export const ACK_STATUS_TEXT: Readonly<Record<AckStatus, string>> = {
  pending: "Response requested",
  acknowledged: "Responsibility taken",
  escalated: "Escalated",
  failed_unreachable: "Nobody could be reached",
  resolved: "Closed",
  cancelled: "Withdrawn",
};

export const takeName = (author: string | undefined, sent: string): string =>
  `${ACK_TAKE_LABEL} for the message${author ? ` from ${author}` : ""} sent ${sent}`;
export const closeName = (author: string | undefined, sent: string): string =>
  `${ACK_CLOSE_LABEL} for the message${author ? ` from ${author}` : ""} sent ${sent}`;

export const waitingFor = (forViewer: boolean): string =>
  forViewer ? "Waiting for you" : "Waiting for the person it was sent to";
