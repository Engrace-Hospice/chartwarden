// M36 WP 3.10 - the body of a medication question, built by the server from the caller's text (ADR-0067 D2). The text
// is carried VERBATIM in one text node and never inspected: no parsing, no extraction of a drug, dose or order.
import {
  MEDICATION_QUESTION_TEXT_MAX,
  type RichBody,
  type RichInline,
  ChartWardenError,
} from "@chartwarden/types";

const invalid = (message: string): ChartWardenError =>
  new ChartWardenError("VALIDATION_FAILED", message, 422);

/** One paragraph: the text, then (when given) one medication link node. Authorisation of the link is the route's job. */
export function buildMedicationQuestionBody(text: string, medicationId: string | null): RichBody {
  if (text.trim().length === 0) throw invalid("a question is required");
  if (text.length > MEDICATION_QUESTION_TEXT_MAX) throw invalid("the question is too long");
  const content: RichInline[] = [{ type: "text", text }];
  if (medicationId !== null) {
    content.push({ type: "clinicalLink", kind: "medication", entityId: medicationId });
  }
  return { schemaVersion: 1, doc: { type: "doc", content: [{ type: "paragraph", content }] } };
}
