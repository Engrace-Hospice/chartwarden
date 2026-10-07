// apps/web/src/modules/06-admission — the model behind the Discharge / Revocation / Transfer-out workflow
// (discharge-workflow.tsx): the reasons and the route each one posts to, the form, the client mirror of
// the server's per-reason gates, the server-code → message map and the cascade each path runs. Pure (no
// React) so the screen file stays a screen.
import { fmtDate } from "../../shell/patient-context";
import { type WhatHappensItem, addDays } from "./end-of-episode-ui";

// ---------- reasons ----------

export type EndReason =
  | "moved_out_of_service_area"
  | "transfer_out"
  | "revocation"
  | "no_longer_terminal"
  | "for_cause"
  | "other";

export type Endpoint = "discharge" | "revocation" | "transfer-out";

export interface ReasonDef {
  value: EndReason;
  label: string;
  hint: string;
  endpoint: Endpoint;
  /** The permission key the server checks for this reason (route 39 derives it from `reason`). */
  permission: string;
  /** Minimum narrative length — mirrors DISCHARGE_POLICY / the route schemas (server re-checks). */
  minNarrative: number;
  dateLabel: string;
  narrativeLabel: string;
  narrativePrompt: string;
}

export const NARRATIVE_MAX = 4000;
const FOR_CAUSE_MIN = 20;
const FOR_CAUSE_MAX = 2000;
/** NOTR filing window — 42 CFR 418.26: 5 calendar days from the effective date. */
export const NOTR_DUE_DAYS = 5;

export const REASONS: readonly ReasonDef[] = [
  {
    value: "moved_out_of_service_area",
    label: "Moved out of service area",
    hint: "The patient has left the area the hospice serves, with no immediate hospice handoff.",
    endpoint: "discharge",
    permission: "discharge.moved",
    minNarrative: 10,
    dateLabel: "Discharge date",
    narrativeLabel: "Discharge narrative",
    narrativePrompt:
      "Where the patient moved and the date of the move; whether the patient/family was notified of the " +
      "discharge; where records were sent (receiving physician or hospice).",
  },
  {
    value: "transfer_out",
    label: "Transfer out to another hospice",
    hint: "Another hospice takes over care. The benefit period carries over — no new election.",
    endpoint: "transfer-out",
    permission: "transfer.out",
    minNarrative: 10,
    dateLabel: "Transfer effective date",
    narrativeLabel: "Transfer narrative",
    narrativePrompt:
      "Why the patient is transferring, the hand-off contact at the receiving hospice, and what records " +
      "were sent.",
  },
  {
    value: "revocation",
    label: "Revocation",
    hint: "The patient or representative chooses to end the hospice election.",
    endpoint: "revocation",
    permission: "revocation.create",
    minNarrative: 10,
    dateLabel: "Revocation date",
    narrativeLabel: "Revocation narrative",
    narrativePrompt:
      "The patient's stated reason in their own words, who signed the revocation statement, and the " +
      "education given about re-electing the benefit later.",
  },
  {
    value: "no_longer_terminal",
    label: "No longer terminally ill",
    hint: "The patient's condition no longer supports a prognosis of six months or less.",
    endpoint: "discharge",
    permission: "discharge.no_longer_terminal",
    minNarrative: 20,
    dateLabel: "Discharge date",
    narrativeLabel: "Clinical narrative",
    narrativePrompt:
      "The clinical findings that no longer support a terminal prognosis, the physician's determination, " +
      "and the education given to the patient/family (including how to re-elect hospice).",
  },
  {
    value: "for_cause",
    label: "Discharge for cause",
    hint: "Safety or compliance grounds. Needs a medical-director cosign before it takes effect.",
    endpoint: "discharge",
    permission: "discharge.for_cause",
    minNarrative: 10,
    dateLabel: "Proposed discharge date",
    narrativeLabel: "Discharge narrative",
    narrativePrompt:
      "The sequence of events, what was done to resolve the problem, and how the patient/family was " +
      "told about the proposed discharge.",
  },
  {
    value: "other",
    label: "Other live discharge",
    hint: "A live discharge that fits none of the reasons above. A detailed narrative is required.",
    endpoint: "discharge",
    permission: "discharge.other",
    minNarrative: 40,
    dateLabel: "Discharge date",
    narrativeLabel: "Discharge narrative",
    narrativePrompt:
      "Explain the reason in full: what happened, who decided, who was notified, and where records went.",
  },
];

export const REASON_BY_VALUE = new Map(REASONS.map((r) => [r.value, r]));

export const REVOCATION_REASONS = [
  { value: "seek_curative_treatment", label: "Seeking curative treatment" },
  { value: "dissatisfaction", label: "Dissatisfied with hospice care" },
  { value: "transferred_out", label: "Transferred out" },
  { value: "other", label: "Other" },
] as const;
export type RevocationReason = (typeof REVOCATION_REASONS)[number]["value"];

/** Where the RECEIVING hospice cares for the patient — the final claim's patient status 50 / 51. */
export const RECEIVING_CARE_SETTINGS = [
  { value: "home", label: "At home" },
  { value: "facility", label: "In a facility (nursing home or other facility)" },
] as const;
export type ReceivingCareSetting = (typeof RECEIVING_CARE_SETTINGS)[number]["value"];

const CCN_PATTERN = /^[0-9A-Z]{6}$/;

// ---------- form ----------

export interface FormState {
  reason: EndReason | null;
  narrative: string;
  date: string;
  forCauseReason: string;
  otherHospiceName: string;
  otherHospiceCcn: string;
  receivingCareSetting: ReceivingCareSetting | "";
  revocationReason: RevocationReason | "";
  signingRole: "patient" | "legal_representative";
  signingPatientName: string;
  attested: boolean;
}

export const EMPTY_FORM: FormState = {
  reason: null,
  narrative: "",
  date: "",
  forCauseReason: "",
  otherHospiceName: "",
  otherHospiceCcn: "",
  receivingCareSetting: "",
  revocationReason: "",
  signingRole: "patient",
  signingPatientName: "",
  attested: false,
};

export type StepId = "reason" | "details" | "date" | "review" | "confirm";
export const STEPS: { id: StepId; title: string }[] = [
  { id: "reason", title: "Reason" },
  { id: "details", title: "Details" },
  { id: "date", title: "Effective date" },
  { id: "review", title: "Review what happens" },
  { id: "confirm", title: "Confirm" },
];

// ---------- validation (client mirror of the server gates) ----------

export type Errors = Partial<Record<keyof FormState, string>>;

export function validateDetails(form: FormState): Errors {
  const def = form.reason ? REASON_BY_VALUE.get(form.reason) : undefined;
  if (!def) return {};
  const errors: Errors = {};
  const len = form.narrative.trim().length;
  if (len < def.minNarrative)
    errors.narrative = `Enter at least ${def.minNarrative} characters (${len} so far).`;
  else if (form.narrative.length > NARRATIVE_MAX)
    errors.narrative = `Keep the narrative under ${NARRATIVE_MAX} characters.`;
  if (def.value === "for_cause") {
    const n = form.forCauseReason.trim().length;
    if (n < FOR_CAUSE_MIN) errors.forCauseReason = `Enter at least 20 characters (${n} so far).`;
    else if (form.forCauseReason.length > FOR_CAUSE_MAX)
      errors.forCauseReason = "Keep the reason under 2000 characters.";
  }
  if (def.value === "transfer_out") {
    if (form.otherHospiceName.trim().length === 0)
      errors.otherHospiceName = "Enter the receiving hospice's name.";
    const ccn = form.otherHospiceCcn.trim();
    if (ccn && !CCN_PATTERN.test(ccn))
      errors.otherHospiceCcn = "A CCN is 6 characters — digits and capital letters.";
    if (!form.receivingCareSetting) errors.receivingCareSetting = "Choose home or facility.";
  }
  if (def.value === "revocation") {
    if (!form.revocationReason) errors.revocationReason = "Choose the revocation reason.";
    if (form.signingPatientName.trim().length === 0)
      errors.signingPatientName = "Enter the name of the person who signed.";
  }
  return errors;
}

export function validateDate(
  date: string,
  admissionDate: string | null,
  today: string,
): string | null {
  if (!date) return "Choose the effective date.";
  if (date > today) return "The effective date cannot be in the future.";
  if (admissionDate && date < admissionDate)
    return `The effective date cannot be before the admission date (${fmtDate(admissionDate)}).`;
  return null;
}

// ---------- server error mapping ----------

const CODE_MESSAGES: Record<string, string> = {
  DISCHARGE_NARRATIVE_TOO_SHORT:
    "The narrative is shorter than this reason requires. Add more detail and submit again.",
  NARRATIVE_REQUIRED_FOR_CAUSE:
    "A for-cause discharge needs a for-cause reason of at least 20 characters.",
  DISCHARGE_BEFORE_ADMISSION:
    "The effective date is before the admission date. Choose a later date.",
  REVOCATION_EFFECTIVE_BEFORE_SIGNED:
    "The revocation cannot take effect before the date it was signed.",
  TRANSFER_LIMIT_EXCEEDED:
    "A transfer out has already been recorded in this benefit period — only one is allowed per period.",
  RECEIVING_CARE_SETTING_REQUIRED:
    "Choose where the receiving hospice will care for the patient (at home or in a facility) on the " +
    "transfer step — it sets the final claim's patient status (50 or 51).",
  PLACE_OF_DEATH_NOT_ALLOWED:
    "A place of death is only recorded on a death. Use Record death on the admission for a death.",
  // 42 CFR 418.26(b) (FY 2027) — the physician discharge order (physician-authority.ts on the server).
  DISCHARGE_ORDER_REQUIRED:
    "A discharge dated on or after October 1, 2026 needs the physician discharge order. Add the ordering " +
    "physician on the effective-date step.",
  DISCHARGE_ORDER_TIMING_INVALID:
    "The discharge order must be signed no later than the discharge date and not in the future.",
  PHYSICIAN_SIGNER_INVALID:
    "That physician can't sign this discharge order. Choose the medical director, a physician designee, or " +
    "this patient's IDG physician.",
  FOR_CAUSE_REQUIRES_COSIGN:
    "A for-cause discharge cannot take effect until the medical director cosigns it.",
  ILLEGAL_TRANSITION:
    "This admission can no longer be ended this way — it may already be discharged, or it has no active " +
    "benefit period. Reload the admission to see its current state.",
};

export function messageForError(status: number | undefined, code: string | undefined): string {
  if (code && CODE_MESSAGES[code]) return CODE_MESSAGES[code];
  if (status === 403) return "You do not have permission to record this reason for this patient.";
  if (status === 404) return "This admission was not found or is no longer visible to you.";
  if (status === 409) return "The admission changed since you opened it. Reload and try again.";
  if (status === 422 || status === 400)
    return "Some values were rejected — check the details and dates.";
  return "The request could not be completed. Nothing was changed; try again.";
}

// ---------- cascades ----------

/** The cascades the backend runs for each path, stated plainly (spec "Cascades" + the M23/M22 consumers). */
export function cascadeItems(reason: EndReason, date: string | null): WhatHappensItem[] {
  if (reason === "for_cause")
    return [
      { icon: "clock", text: "The discharge is filed as pending the medical director's cosign." },
      {
        icon: "heart",
        text: "Until the cosign, the patient stays on service: the admission stays open and the benefit period continues.",
      },
      {
        icon: "receipt",
        text: "Once cosigned, the period closes, the level of care ends, the admission becomes discharged and billing drafts the NOTR.",
      },
    ];
  const cause =
    reason === "revocation"
      ? " — cause: revocation"
      : reason === "transfer_out"
        ? " — cause: transfer; the receiving hospice continues it, no new election needed"
        : " — cause: discharge";
  const document =
    reason === "revocation"
      ? "A revocation document is generated for the chart."
      : reason === "transfer_out"
        ? "A transfer discharge summary is generated for the chart."
        : "A discharge summary is generated for the chart.";
  return [
    { icon: "calendar-check", text: `The active benefit (election) period closes${cause}.` },
    { icon: "bed", text: "The current level of care ends." },
    { icon: "clipboard-check", text: "The admission becomes Discharged." },
    {
      icon: "receipt",
      text: date
        ? `Billing drafts the NOTR — due within 5 calendar days, by ${fmtDate(addDays(date, NOTR_DUE_DAYS))}.`
        : "Billing drafts the NOTR — due within 5 calendar days of the effective date.",
    },
    { icon: "file-text", text: document },
  ];
}

// ---------- copy ----------

export function attestationText(reason: EndReason): string {
  switch (reason) {
    case "revocation":
      return "I confirm the patient or their legal representative signed a revocation statement on this date.";
    case "transfer_out":
      return "I confirm the receiving hospice has accepted the patient and the transfer date is agreed.";
    case "for_cause":
      return "I confirm the grounds above are documented and the patient/family has been told about the proposed discharge.";
    default:
      return "I confirm the patient/family has been notified of the discharge and the details above are accurate.";
  }
}

export function submitLabel(reason: EndReason | undefined): string {
  switch (reason) {
    case "revocation":
      return "Record revocation";
    case "transfer_out":
      return "Transfer out";
    case "for_cause":
      return "File for cosign";
    default:
      return "Discharge patient";
  }
}

export function noticeVerb(reason: EndReason): string {
  if (reason === "revocation") return "Revocation recorded";
  if (reason === "transfer_out") return "Transfer out recorded";
  return "Patient discharged";
}

export function careSettingLabel(value: ReceivingCareSetting | ""): string {
  return RECEIVING_CARE_SETTINGS.find((o) => o.value === value)?.label ?? "—";
}
