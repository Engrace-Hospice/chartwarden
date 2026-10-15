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

export const waitingFor = (forViewer: boolean): string =>
  forViewer ? "Waiting for you" : "Waiting for the person it was sent to";
