// M36 G2 - "Needs a response": the optional ask-one-colleague control of the composer. Wording is PROVISIONAL pending
// clinical-lead review (change the text here, never the codes). Sending the message and asking are two calls: the message is
// stored first, then POST /escalations names the colleague (the server derives class `important`, 60 min). Asking is NOT a page
// and NOT the emergency path, and opening a message never counts as taking responsibility.
import type { ApiClient } from "@chartwarden/ui";
import { REQUEST_TIMEOUT_MS } from "./messaging-utils";

export const NEEDS_RESPONSE_LABEL = "Needs a response";
export const NEEDS_RESPONSE_NOTICE =
  "Asks one colleague to take responsibility for this message. This does not page anyone and is not the emergency path. Opening or reading the message does not count as taking responsibility.";
export const NEEDS_RESPONSE_PICKER_LEGEND = "Ask (choose one qualified colleague)";
export const NEEDS_RESPONSE_NONE_TEXT =
  "No qualified colleague is available in this conversation. Use the agency telephone procedure.";
export const NEEDS_RESPONSE_CHOOSE_TEXT = "Choose who to ask first.";
export const askLine = (name: string): string =>
  `Ask ${name} to take responsibility for this message.`;
export const requestedText = (name: string): string =>
  `Message sent. ${name} was asked to take responsibility. This is not a page.`;
export const REQUEST_FAILED_TEXT =
  "Your message was sent, but the request for a response was not made. Call your colleague or use the agency telephone procedure.";
export const REQUEST_INDETERMINATE_TEXT =
  "Your message was sent, but the request for a response may not have been made. Check the message in the conversation; if there is no request on it, call your colleague.";

export type RequestOutcome = "ok" | "refused" | "indeterminate";

/** Never throws. A 5xx, a 409 or no answer is indeterminate (the request may exist); the rest is a definitive no. */
export async function requestResponse(
  client: ApiClient,
  messageId: string,
  assigneeUserId: string,
): Promise<RequestOutcome> {
  try {
    const { data, response } = await client.POST("/api/v1/messaging/escalations", {
      params: { header: { "Idempotency-Key": crypto.randomUUID() } },
      body: { message_id: messageId, assigned_user_id: assigneeUserId },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (data) return "ok";
    const status = response?.status;
    return status === undefined || status >= 500 || status === 409 ? "indeterminate" : "refused";
  } catch {
    return "indeterminate";
  }
}

/** What the sender needs from the control. `recipientId` is empty until a colleague is chosen. */
export interface NeedsResponseSend {
  /** The box is checked. */
  readonly checked: boolean;
  readonly recipientId: string;
  /** Checked but nobody chosen: the send is refused and the control says why. */
  readonly onMissingRecipient: () => void;
  /** The message went out; the outcome of the follow-up request. */
  readonly onRequested: (outcome: RequestOutcome) => void;
}
