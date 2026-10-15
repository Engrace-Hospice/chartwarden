// M36 WP 3.10 - every word the medication-question UI shows, in one place. PROVISIONAL pending clinical-lead review (no
// sign-off is recorded): change the text here, never the codes. A message never changes a medication or creates an
// order; the notices below say so plainly, and nothing in this feature links to an order action.

export const ASK_BUTTON_LABEL = "Ask a nurse about a medication";
export const ASK_DIALOG_TITLE = "Ask a nurse about a medication";
export const QUESTION_LABEL = "Your question";
export const MEDICATION_LABEL = "Medication (optional)";
export const NO_MEDICATION_OPTION = "No medication selected";
export const DESCRIBE_MEDICATION_HINT = "Describe the medication in your question.";
export const SEND_TO_LABEL = "Send to";
export const CHOOSE_NURSE_OPTION = "Choose a nurse or colleague";
export const SEND_LABEL = "Send question";
export const SEND_WITHOUT_NURSE_LABEL = "Send without a nurse and alert your clinical supervisor";
export const NO_ORDER_NOTICE =
  "A message never changes a medication or creates an order. The nurse reviews your question and contacts the prescriber; any order is entered in Orders.";
export const NOT_EMERGENCY_NOTICE =
  "This is not the emergency path; follow the agency phone procedure if urgent.";
export const ENTER_QUESTION_TEXT = "Write your question first.";
export const NO_NURSE_TEXT =
  "No nurse is assigned to this patient. Choose a colleague, or send without a nurse and your clinical supervisor will be alerted.";
export const SENT_ROUTED_TEXT = "Question sent. The nurse has a task to review it.";
export const SENT_UNROUTED_TEXT =
  "Question sent without a nurse. Your clinical supervisor has been alerted. This is not the emergency path.";
export const SENT_REPLAY_TEXT = "That question was already sent. It was not sent again.";
/** H-04: shown under every medication link in a message. */
export const MEDICATION_LINK_NOTICE =
  "Messages can't change medications. Orders are entered in Orders.";
export const UNKNOWN_PERSON = "a colleague";

/** "Goes to <name>, the patient's assigned nurse" (name is data; the sentence is wording). */
export const nurseOptionLabel = (name: string | null): string =>
  `${name ?? UNKNOWN_PERSON}, the patient's assigned nurse`;
export const goesToLine = (name: string | null): string =>
  `Goes to ${name ?? UNKNOWN_PERSON}, the patient's assigned nurse`;

const FIELD_ERRORS: Readonly<Record<string, string>> = {
  MEDICATION_QUESTION_NOT_PATIENT_CHANNEL:
    "Medication questions can only be sent in a patient's care team conversation.",
  MEDICATION_QUESTION_ASSIGNEE_INVALID:
    "That person cannot take this question. Choose someone else.",
  MEDICATION_QUESTION_NO_NURSE: NO_NURSE_TEXT,
  CLINICAL_LINK_NOT_AVAILABLE:
    "You cannot link that medication. Nothing was sent. Describe the medication in your question instead.",
  CHANNEL_ARCHIVED: "This conversation is archived. Nothing was sent.",
  VALIDATION_FAILED: "The question could not be sent as written. Check it and try again.",
};

/** A server refusal as text: the typed code wins, then the HTTP status, then a generic line. */
export function medicationQuestionErrorText(
  status: number | undefined,
  code: string | undefined,
): string {
  if (code && Object.hasOwn(FIELD_ERRORS, code)) return FIELD_ERRORS[code] as string;
  if (status === 403) return "You are not allowed to send a medication question here.";
  if (status === 404) return "Medication questions are not available here.";
  return "That did not work. Nothing was sent. Try again.";
}
