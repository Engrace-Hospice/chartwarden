// apps/web/src/modules/08-encounters — what the cosigner reads when a cosignature step (acknowledge, sign, supervisor release) is refused, for
// a note and for an amendment of a signed note (ADR-0114 VN-D30, S1 PR E4). Each sentence is the app's own and says what happened, whether
// anything changed, and the next step; the server's text is never shown, and a code not listed reads as a general failure. The server decides
// every refusal; this only words it. (A 401 is `write-workflow.ts`'s redirect to sign-in; the step-up link is the ceremony's.)
import type { CosignStep, CosignSubjectKind } from "./cosign-model";

export interface CosignRefusal {
  readonly status: number | undefined;
  readonly code: string | undefined;
  /** The server's own text, read only to recognise a step-up refusal worded as a plain 403; it is never shown. */
  readonly message?: string | undefined;
  readonly step: CosignStep;
  readonly subject: CosignSubjectKind;
}

/**
 * A refusal whose fix is the real `/step-up` screen, not a different action: a fresh re-authentication is missing. Same recognition as
 * `authFailureRedirect` plus the sign machine's own `STEP_UP_AUTH_REQUIRED` (a 412), which that helper does not name.
 */
export function isStepUpRefusal({
  status,
  code,
  message,
}: {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly message: string | undefined;
}): boolean {
  return (
    code === "STEP_UP_REQUIRED" ||
    code === "STEP_UP_AUTH_REQUIRED" ||
    (status === 403 && message?.includes("step_up_recent") === true)
  );
}

const NOT_CHANGED = "Nothing was changed.";

const reauthenticate = (step: CosignStep): string =>
  `This step needs a fresh re-authentication, and yours is out of date. ${NOT_CHANGED} Re-authenticate, then ${step} again.`;

const forbidden = (step: CosignStep, noun: string): string =>
  step === "release"
    ? `Only a clinical supervisor or the director of nursing can release this ${noun}. ${NOT_CHANGED} Ask one of them to release it.`
    : `You cannot do this: only an RN with cosign access who wrote neither the note nor this ${noun} can. ${NOT_CHANGED} Ask that RN to do it.`;

export function cosignRefusalMessage({
  status,
  code,
  message,
  step,
  subject,
}: CosignRefusal): string {
  const noun = subject === "addendum" ? "amendment" : "note";
  // A step-up refusal first: a 403 that names step_up_recent is a stale re-authentication, not a statement about the cosigner's role.
  if (isStepUpRefusal({ status, code, message })) return reauthenticate(step);
  switch (code) {
    case "ILLEGAL_TRANSITION":
      return `This ${noun}'s cosignature request is no longer waiting for this step: someone else may have already acknowledged, signed or released it. ${NOT_CHANGED} Reload the page to see where it stands.`;
    case "COSIGNATURE_LOCKED":
      return `This ${noun} is locked at the 48-hour cap, so it cannot be cosigned yet. ${NOT_CHANGED} A supervisor has to release it first, then an RN can sign.`;
    case "SUPERVISOR_RELEASE_NOT_PERMITTED":
      return forbidden("release", noun);
    case "NOT_COSIGN_ELIGIBLE":
      return `Only a registered nurse can sign a cosignature, and your account does not hold the RN role. ${NOT_CHANGED} An RN who wrote neither the note nor this ${noun} has to sign it.`;
    case "SUPERVISOR_RELEASE_REASON_TOO_SHORT":
      return "The reason is too short: it needs at least 40 characters. Add detail, then release again.";
  }
  if (status === 403) return forbidden(step, noun);
  if (status === 404) {
    return `This ${noun}'s cosignature request could not be found. ${NOT_CHANGED} Reload the page to see the current record.`;
  }
  if (status === 409) {
    return `This ${noun} changed while you were working. ${NOT_CHANGED} Reload the page, then try again.`;
  }
  return "The action could not be completed. Try again in a moment; if it keeps failing, reload the page to see whether it already went through.";
}
