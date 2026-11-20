// apps/web/src/modules/08-encounters — what the signer reads when a ceremony write (sign, acknowledge, cosign, release) is refused. Each
// sentence is the app's own and says what happened to the note and what to do next; a code not listed reads as a general failure. The
// server decides every refusal; this only words it. (Auth redirects — 401, step-up — are `write-workflow.ts`.)
import { signStaleMessage } from "./draft-model";
import { humanizeSection } from "./sign-draft-notice";

/** The server's refusal of a sign whose note was finalized with Part 2 draft text while the draft is switched off for the tenant. */
export const DRAFT_OFF_AFTER_FINALIZE_CODE = "DRAFT_OFF_AFTER_FINALIZE";

const DRAFT_OFF_AFTER_FINALIZE_MESSAGE =
  "This note was finalized with drafted text, but the visit-note draft is switched off for your organization now, so it cannot be signed as it stands. Nothing was changed: the note is still finalized. Ask an administrator to switch the visit-note draft back on (Admin, Visit-note Draft), then sign again.";

export interface WriteRefusal {
  readonly status: number | undefined;
  readonly code: string | undefined;
  /** The envelope's own text: used only where the server's wording is the message (a visit time it could not accept). */
  readonly message: string | undefined;
  readonly details: unknown;
}

export function writeRefusalMessage({ status, code, message, details }: WriteRefusal): string {
  switch (code) {
    case "MODALITY_CONFIRMATION_REQUIRED":
      return "Choose how this visit was delivered, then sign again.";
    case "MODALITY_CONFLICTS_WITH_VISIT_TYPE":
      return "This is a telephonic visit type, so it cannot be recorded as in person or video. Choose Telephonic, then sign again.";
    case "VISIT_TIME_INVALID":
      return message ?? "The visit times could not be accepted. Check them and sign again.";
    case "VISIT_TIME_OVERLAP":
      return "These visit times overlap another visit you documented. Correct the times, or clear them and sign without times.";
    case "EVV_BRACKET_UNAVAILABLE":
      return "The visit's check-in/check-out record could not be reached, so typed times cannot be accepted right now. Try again in a moment, or clear the times and sign without them.";
    case "DRAFT_SECTION_STALE":
      return signStaleMessage(details, humanizeSection);
    case DRAFT_OFF_AFTER_FINALIZE_CODE:
      return DRAFT_OFF_AFTER_FINALIZE_MESSAGE;
    case "COMPLIANCE_GATE_UNAVAILABLE":
      return "The visit-note draft could not be checked right now. Try again in a moment.";
    case "STALE_VERSION":
      return "This encounter changed since you opened it — reload to retry.";
  }
  if (status === 412 && code === "STEP_UP_AUTH_REQUIRED")
    return "Your step-up expired — try again.";
  if (status === 403) return "You do not have permission for this action.";
  return "The action could not be completed.";
}
