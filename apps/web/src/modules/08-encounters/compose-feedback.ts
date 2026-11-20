// apps/web/src/modules/08-encounters — what the composer tells the author when a save or a finalize is refused (or the connection drops):
// the banner's tone, title and words. The server decides every refusal; this only words it (extracted from encounter-compose.tsx).
import { TRANSPORT_MESSAGE, readableValidation } from "./compose-text";
import type { WriteResult } from "./encounters-api";

export type UiFeedback = {
  tone: "success" | "error" | "warning";
  title: string;
  message: string;
  field?: string;
  /** Names a notice that goes away by itself once what it is about is no longer true. */
  tag?: "findings-unsaved";
};

export function feedbackFor(result: Extract<WriteResult<unknown>, { ok: false }>): UiFeedback {
  if (result.code === "STALE_VERSION")
    return {
      tone: "warning",
      title: "This visit note changed",
      message:
        "The note was updated after you opened it. Reload the latest version before continuing.",
    };
  if (result.code === "COMPLIANCE_GATE_UNAVAILABLE" || result.code === "DRAFT_UNAVAILABLE")
    return {
      tone: "error",
      title: "The draft could not be checked",
      message:
        "The visit-note draft could not be checked right now. The note was not finalized. Try again in a moment.",
    };
  const first = Array.isArray(result.details) ? result.details[0] : result.details;
  const field =
    first && typeof first === "object" && typeof (first as { field?: unknown }).field === "string"
      ? (first as { field: string }).field
      : undefined;
  return {
    tone: "error",
    title: "Action needed",
    message: readableValidation(result.details, result.message),
    field,
  };
}

export const transportFeedback: UiFeedback = {
  tone: "error",
  title: "Connection interrupted",
  message: TRANSPORT_MESSAGE,
};
