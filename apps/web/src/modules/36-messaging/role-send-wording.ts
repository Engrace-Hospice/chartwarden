// M36 role-based send (ADR-0081, PROPOSED) - every word the "Message on-call role" UI shows, in one place. PROVISIONAL pending clinical-lead
// review (docs/adr/ADR-0081-messaging-role-send.md lists the open wording questions): change the text here, never the codes. Messaging is
// NOT the emergency path; a gap or an unconnected roster is said in words and nothing is sent, never a guessed person.
import {
  type OnCallDirectoryRole,
  ROLE_SEND_ERROR_CODES,
  ROLE_SEND_TELEPHONE_PROCEDURE,
} from "@wardenx/types";
import { asOfText, untilText } from "./oncall-directory-wording";

export const ROLE_SEND_BUTTON_LABEL = "Message on-call role";
export const ROLE_SEND_DIALOG_TITLE = "Message the on-call role";
export const ROLE_SEND_NOT_EMERGENCY_NOTICE =
  "This is not the emergency path. For critical symptoms follow the agency telephone/emergency procedure; do not rely on this message alone.";
export const ROLE_SEND_NO_PAGE_NOTICE =
  "Sending does not page or escalate anyone. The person on call is told in the app only. If you need an answer now, call them.";
export const ROLE_LEGEND = "Which role? (required)";
export const ROLE_NAMES: Readonly<Record<OnCallDirectoryRole, string>> = {
  rn: "RN",
  physician: "Physician",
};
export const CHOOSE_ROLE_TEXT = "Choose a role first.";
export const REVIEW_LABEL = "Check who is on call";
export const BACK_LABEL = "Back";
export const CANCEL_LABEL = "Cancel";
export const RETRY_LABEL = "Try again";
export const LOADING_TEXT = "Finding who is on call...";
export const CONFIRM_LEGEND = "Confirm who is on call (required)";
export const CHOOSE_PERSON_TEXT = "Choose the person you are messaging.";
export const NAME_UNKNOWN_TEXT = "Name not available";
export const NO_COVERAGE_TEXT = ROLE_SEND_TELEPHONE_PROCEDURE;
export const NOT_CONNECTED_TEXT =
  "The on-call roster is not connected, so who is on call is unknown. Nothing was sent. Use the agency telephone procedure.";
export const NOT_CONFIGURED_TEXT =
  "No on-call schedule is set up for this role. Nothing was sent. Use the agency telephone procedure.";
export const NAMES_UNAVAILABLE_TEXT =
  "Someone is on call but their name could not be shown, so they cannot be confirmed. Nothing was sent. Use the agency telephone procedure.";
export const CHANGED_TEXT =
  "Who is on call changed. Nothing was sent. Check the name below and confirm again.";
export const LOOKUP_FAILED_TEXT =
  "Could not find out who is on call. Nothing was sent. Try again, or use the agency telephone procedure.";
export const NOT_AVAILABLE_TEXT =
  "Messaging a role is not available here. Nothing was sent. Use the agency telephone procedure.";
export const UNTRACKED_TEXT =
  "Messaging a role is unavailable right now. Nothing was sent. Use the agency telephone procedure.";
export const INDETERMINATE_TEXT =
  "It may not have been sent. Check the conversation before trying again; sending the same message again will not duplicate it.";
export const RATE_LIMITED_TEXT =
  "Too many urgent messages just now. Nothing was sent. Wait a minute and try again.";
export const GENERIC_FAILURE_TEXT = "That did not work. Nothing was sent. Try again.";
export const sentText = (role: OnCallDirectoryRole, name: string): string =>
  `Urgent message sent to ${name}, the on-call ${ROLE_NAMES[role]}. They have been told in the app. This is not a page.`;
export const SENT_REPLAY_TEXT = "That message was already sent. It was not sent again.";
export const KEEP_EDITING_LABEL = "Keep editing";
export const KEEP_DRAFT_LABEL = "Close, keep draft";
export const DISCARD_LABEL = "Discard draft";
export const DISCARD_PROMPT = "Close this message? You can keep what you typed, or discard it.";
export const SBAR_LOADING_TEXT = "Loading the message form...";
export const SBAR_UNAVAILABLE_TEXT = "The SBAR form is not available. Nothing was sent.";

export const personLine = (role: OnCallDirectoryRole, name: string | null): string =>
  `${name ?? NAME_UNKNOWN_TEXT}, on call ${ROLE_NAMES[role]}`;

/** "until 7:00 PM PDT (as of 2:07 PM PDT)" in the ROSTER's zone; "Shift end not provided" when the roster gave none. */
export function shiftLine(
  asOf: string,
  shiftEndsAt: string | null,
  timeZone: string | null,
): string {
  if (!timeZone) return "Shift time not provided";
  const asOfPart = asOfText(asOf, timeZone);
  return shiftEndsAt
    ? `${untilText(shiftEndsAt, asOf, timeZone)} (${asOfPart})`
    : `Shift end not provided (${asOfPart})`;
}

export const confirmLine = (role: OnCallDirectoryRole, name: string): string =>
  `This goes to ${name}, the on-call ${ROLE_NAMES[role]} right now, and is marked urgent. It cannot be edited after sending.`;
export const sendLabel = (name: string): string => `Send urgent message to ${name}`;

/** The refusal text for a resolution that is not a covered role (never an empty list). */
export function refusalText(status: string): string {
  if (status === "roster_not_connected") return NOT_CONNECTED_TEXT;
  if (status === "not_configured") return NOT_CONFIGURED_TEXT;
  return NO_COVERAGE_TEXT;
}

const ERRORS: Readonly<Record<string, string>> = {
  URGENT_NOT_PATIENT_CHANNEL:
    "Urgent clinical messages can only be sent in a patient's care team conversation.",
  URGENT_SBAR_REQUIRED: "An urgent clinical message needs all four SBAR sections.",
  URGENT_RECIPIENT_INVALID:
    "That person cannot take this message. Nothing was sent. Use the agency telephone procedure.",
  CLINICAL_LINK_NOT_AVAILABLE: "A link in the message is not available. Nothing was sent.",
  SBAR_INVALID: "The SBAR sections do not meet the length requirements. Nothing was sent.",
  CHANNEL_ARCHIVED: "This conversation is archived. Nothing was sent.",
  [ROLE_SEND_ERROR_CODES.noCoverage]: NO_COVERAGE_TEXT,
  [ROLE_SEND_ERROR_CODES.resolutionChanged]: CHANGED_TEXT,
  [ROLE_SEND_ERROR_CODES.unavailable]: UNTRACKED_TEXT,
};

const hasTypedText = (code: string | undefined): code is string =>
  code !== undefined && Object.hasOwn(ERRORS, code);

/**
 * A failure that does not prove the message was NOT stored: no response, a 5xx or an untyped 409 (an unfinished idempotent attempt).
 * The typed role-send codes are checked FIRST: a 409 ROLE_SEND_RESOLUTION_CHANGED and a 503 ROLE_SEND_UNAVAILABLE are clean refusals.
 */
export const isIndeterminateSend = (
  status: number | undefined,
  code: string | undefined,
): boolean => !hasTypedText(code) && (status === undefined || status >= 500 || status === 409);

export function sendErrorText(status: number | undefined, code: string | undefined): string {
  if (hasTypedText(code)) return ERRORS[code] as string;
  if (isIndeterminateSend(status, code)) return INDETERMINATE_TEXT;
  if (status === 429) return RATE_LIMITED_TEXT;
  if (status === 403 || status === 404) return NOT_AVAILABLE_TEXT;
  return GENERIC_FAILURE_TEXT;
}
