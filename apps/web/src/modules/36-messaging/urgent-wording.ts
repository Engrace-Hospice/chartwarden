// M36 WP 4.1 - every word the "Urgent clinical" UI shows, in one place. PROVISIONAL pending clinical-lead review (no
// sign-off is recorded; see docs/messaging-hub/brief-clinical-lead-signoff.md): change the text here, never the codes.
// Messaging is NOT the emergency path, and sending an urgent message does not page, escalate or ask anyone to
// respond to it: the notices below say so plainly and no tenant can remove them.
export const URGENT_BUTTON_LABEL = "Urgent clinical";
export const URGENT_DIALOG_TITLE = "Urgent clinical message";
export const URGENT_BADGE_TEXT = "Urgent clinical";
export const URGENT_BADGE_ARIA = "Urgent clinical message";
export const NOT_EMERGENCY_NOTICE =
  "This is not the emergency path. For critical symptoms follow the agency telephone/emergency procedure; do not rely on this message alone.";
export const NO_PAGE_NOTICE =
  "Sending does not page or escalate anyone. Your colleague is told in the app only. If you need an answer now, call them.";
export const RECIPIENT_LEGEND = "Send to (choose one qualified colleague)";
export const NO_RECIPIENT_TEXT =
  "No qualified colleague is available in this conversation. Use the agency telephone procedure.";
export const CHOOSE_RECIPIENT_TEXT = "Choose who this goes to first.";
export const SBAR_LOADING_TEXT = "Loading the message form...";
export const SBAR_UNAVAILABLE_TEXT = "The SBAR form is not available. Nothing was sent.";
export const SENT_TEXT =
  "Urgent message sent. Your colleague has been told in the app. This is not a page.";
export const SENT_REPLAY_TEXT = "That urgent message was already sent. It was not sent again.";
export const UNKNOWN_PERSON = "a colleague";

export const confirmLine = (name: string | null): string =>
  `This goes to ${name ?? UNKNOWN_PERSON} and is marked urgent. It cannot be edited after sending.`;
export const sendLabel = (name: string | null): string =>
  `Send urgent message to ${name ?? UNKNOWN_PERSON}`;

const ERRORS: Readonly<Record<string, string>> = {
  URGENT_NOT_PATIENT_CHANNEL:
    "Urgent clinical messages can only be sent in a patient's care team conversation.",
  URGENT_SBAR_REQUIRED: "An urgent clinical message needs all four SBAR sections.",
  URGENT_RECIPIENT_INVALID: "That colleague cannot take this message. Choose someone else.",
  CLINICAL_LINK_NOT_AVAILABLE: "A link in the message is not available. Nothing was sent.",
  SBAR_INVALID: "The SBAR sections do not meet the length requirements. Nothing was sent.",
  CHANNEL_ARCHIVED: "This conversation is archived. Nothing was sent.",
};

/** A server refusal as text: the typed code wins, then the HTTP status, then a generic line. */
export function urgentErrorText(status: number | undefined, code: string | undefined): string {
  if (code && Object.hasOwn(ERRORS, code)) return ERRORS[code] as string;
  if (status === 403) return "You are not allowed to send an urgent clinical message here.";
  if (status === 404) return "Urgent clinical messages are not available here.";
  return "That did not work. Nothing was sent. Try again.";
}
