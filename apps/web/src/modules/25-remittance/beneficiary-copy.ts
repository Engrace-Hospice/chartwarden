// apps/web/src/modules/25-remittance — the visible prompts of the beneficiary-appeal and representative surfaces (milestone
// 13a). Each names an ABSENCE or a limit; none states a CMS rule, a period or a default. Kept in one place so the prompts
// are the same everywhere they appear and the tests assert the exact words.
export const NO_FORM_CONFIGURED =
  "No appointment form configured for your organisation - ask compliance to add one";
export const NO_APPOINTMENT = "No appointment of representative on file";
export const VALIDITY_NOT_RECORDED = "Validity end not recorded";
export const VALIDITY_PASSED = "Validity end passed (as recorded) - confirm with compliance";
export const RECORDS_NOT_FILES = "ChartWarden records this appeal; it does not file it.";
export const APPOINTMENT_GRANTS_NOTHING =
  "An appointment is a record only. It gives the representative no portal access, consent or caregiver status, and it never changes the hospice's own appeals.";
export const NO_DUE_DATE_ENTER = "No due date recorded - enter it from the notice";
export const NO_BENEFICIARY_APPEALS =
  "No beneficiary-filed appeal has been recorded for this claim.";

/** The first reason an appointment cannot be activated by this person, or null when it can. Mirrors the server's checks. */
export function activationBlockedReason(input: {
  readonly recordedByMe: boolean;
  readonly hasDocument: boolean;
  readonly elementsMissing: number;
}): string | null {
  if (input.recordedByMe) {
    return "You recorded this appointment, so a second person must activate it.";
  }
  if (!input.hasDocument) return "Attach the signed appointment document first.";
  if (input.elementsMissing > 0) {
    return `Confirm the ${input.elementsMissing} required element${input.elementsMissing === 1 ? "" : "s"} still missing first.`;
  }
  return null;
}
