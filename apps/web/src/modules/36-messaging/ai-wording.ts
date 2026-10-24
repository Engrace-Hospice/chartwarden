// M36 WP 6.5 (ADR-0095) - the wording of the AI summary panel, in one file so the clinical lead and compliance review it in one place.
// Provisional until that sign-off (hazard H-08). Plain words; the label and the guardrail line are mandatory (UI spec 6.5).

export const AI_PANEL_TITLE = "AI summary · draft · not verified";
export const AI_GUARDRAIL =
  "AI-generated draft. It can be wrong. It is not a chart note and does not send, order or change anything.";
export const AI_NOT_A_SUBSTITUTE =
  "A summary never replaces reading an urgent message or answering a request that asks you to acknowledge it.";
export const AI_TRIGGER_LABEL = "AI summary";
export const AI_GENERATING = "Reading the conversation...";
export const AI_CANCEL = "Cancel";
export const AI_UNAVAILABLE_TEXT = "AI unavailable. Read the conversation instead.";
export const AI_LIMITED_TEXT = "You have reached the AI limit for now. Try again later.";
export const AI_REFUSED_TEXT =
  "The AI answer was withheld because it stated a dose, an order or a diagnosis. Read the conversation instead.";
export const AI_NOT_FOR_CHANNEL_TEXT = "AI is not available for this conversation.";
export const AI_GENERIC_ERROR = "Something went wrong. Read the conversation instead.";
export const AI_TOO_LITTLE = "Too little to summarise.";
export const AI_NO_OPEN_QUESTIONS =
  "No open questions were found, but a summary can miss things. Read the messages that matter.";
export const AI_UNCERTAINTY_LEAD = "Unclear from the messages:";
export const AI_COPY_TO_DRAFT = "Copy to draft";
export const AI_REGENERATE = "Regenerate";
export const AI_NOT_USEFUL = "Not useful";
export const AI_DRAFT_REPLY = "Draft a reply";
export const AI_DRAFTS_TITLE = "Draft replies · edit before sending";
export const AI_BACK_TO_SUMMARY = "Back to summary";
export const AI_COPIED = "Copied to the message box. Edit it before you send.";

export const CONFIDENCE_TEXT: Readonly<Record<"high" | "medium" | "low", string>> = {
  high: "Stated plainly",
  medium: "Implied",
  low: "Unclear",
};

export function basedOn(included: number): string {
  return `Based on ${included} message${included === 1 ? "" : "s"} you can see`;
}

export function notIncluded(withheld: number): string {
  return `${withheld} message${withheld === 1 ? "" : "s"} not included`;
}
