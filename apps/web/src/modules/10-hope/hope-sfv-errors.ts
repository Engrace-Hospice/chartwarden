// apps/web/src/modules/10-hope — what the SFV completion dialog says when the server refuses, or never answers.
import {
  ATTESTATION_STALE_CODE,
  ATTESTATION_STALE_MESSAGE,
  REFUSED_WITHOUT_REASON,
  errorCodeOf,
  refusalWordsOf,
  serverFaultMessage,
} from "./hope-api";

export interface SfvError {
  readonly title: string;
  readonly message: string;
  /** A refusal of permission rather than of the content: drawn as a warning, not an error. */
  readonly warning?: boolean;
}

/** The request got no usable answer at all. It may still have been applied, so this never says it was not. */
export const SFV_UNCONFIRMED: SfvError = {
  title: "Result not confirmed",
  message:
    "Could not confirm that the follow-up visit was recorded. Check the worklist before trying again.",
};

/** A 4xx that came back with no error body: refused, and no reason to show. Not "unconfirmed": it was answered. */
export const SFV_REFUSED_WITHOUT_REASON: SfvError = {
  title: "The SFV was not completed",
  message: REFUSED_WITHOUT_REASON,
};

/**
 * The attestation wording this page shows is out of date. A definite refusal: nothing was written, and the page
 * cannot send the new version, so it must be reloaded.
 */
export const SFV_WORDING_CHANGED: SfvError = {
  title: "Attestation wording changed",
  message: ATTESTATION_STALE_MESSAGE,
};

const ADMISSION_UNAVAILABLE =
  "The admission record is temporarily unavailable. Try again in a moment.";

const PERMISSION_CODES: ReadonlySet<string> = new Set([
  "FORBIDDEN",
  "PERMISSION_DENIED",
  "INSUFFICIENT_PERMISSIONS",
]);

interface ValidationEnvelope {
  readonly error?: { readonly details?: ReadonlyArray<{ readonly message?: string }> };
}

/** The dialog's own wording for a refusal, keeping the server's message when it sent one and it is the clinician's to read. */
export function sfvErrorFrom(error: unknown, status?: number): SfvError {
  const code = errorCodeOf(error);
  if (code === ATTESTATION_STALE_CODE) return SFV_WORDING_CHANGED;
  // A fault on the server's side (a dependency down, a 5xx): its raw text can carry internals, so the dialog speaks.
  const fault = serverFaultMessage(error, status, ADMISSION_UNAVAILABLE);
  if (fault !== null) {
    return {
      title: code === "DEGRADED" ? "Admission record unavailable" : "Unable to complete SFV",
      message: fault,
    };
  }
  const message = refusalWordsOf(error) ?? undefined;
  if (code !== null && PERMISSION_CODES.has(code)) {
    return {
      title: "You don't have permission to complete this SFV",
      message:
        message ?? "Your current role does not allow you to record a Symptom Follow-Up Visit.",
      warning: true,
    };
  }
  if (code === "VALIDATION_FAILED") {
    const detail = (error as ValidationEnvelope).error?.details?.[0]?.message;
    return {
      title: "Some information needs attention",
      message:
        (typeof detail === "string" ? detail : undefined) ??
        message ??
        "Review the SFV information and try again.",
    };
  }
  if (code === "CONFLICT") {
    return {
      title: "The SFV could not be completed",
      message: message ?? "The assessment has changed. Refresh the assessment and try again.",
    };
  }
  return {
    title: "Unable to complete SFV",
    message: message ?? "Something went wrong while completing the SFV. Please try again.",
  };
}
