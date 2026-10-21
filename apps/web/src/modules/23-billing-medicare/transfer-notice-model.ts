// apps/web/src/modules/23-billing-medicare — the pure model behind the transfer-notice worklist (TOB 8xC /
// corrected 8xC / 8xD; CMS Pub. 100-04 ch. 11 §20.1.3 / §20.1.4). Wire types (the generated client's
// TransferNoticeView), state/action labels and tones, and the client-side checks of the three forms. The
// server re-evaluates every rule; these checks only keep an obviously incomplete form from being sent.
import type { StatusTone } from "@chartwarden/ui";

export type NoticeState =
  | "draft"
  | "ready"
  | "submitted"
  | "ack_pending"
  | "ack_accepted"
  | "ack_rejected"
  | "cancelled";

export type NoticeAction =
  | "confirm_prior_billing"
  | "submit"
  | "cancel"
  | "correct_date"
  | "void"
  | "redraft";

export interface Finding {
  code: string;
  message: string;
  citation: string;
}

export interface TransferNotice {
  transferNoticeId: string;
  patientId: string;
  admissionId: string;
  action: "original" | "correction" | "void";
  supersedesNoticeId: string | null;
  state: NoticeState;
  tob: string;
  statementFromDate: string;
  originalTransferDate: string | null;
  admissionDate: string | null;
  benefitPeriodSequence: number;
  benefitPeriodStartDate: string | null;
  priorHospiceName: string;
  priorHospiceCcn: string | null;
  priorHospiceNpi: string | null;
  providerCcn: string;
  priorBillingConfirmedAt: string | null;
  priorHospiceThroughDate: string | null;
  priorHospicePatientStatus: "50" | "51" | null;
  controlNumber: string;
  payerControlNumber: string | null;
  latestSubmissionOutcome: string | null;
  cancelReason: string | null;
  blockers: Finding[];
  warnings: Finding[];
  conditionCodes: string[];
  occurrenceCodes: { code: string; date: string }[];
  allowedActions: NoticeAction[];
  followUp: { transferNoticeId: string; action: string; state: NoticeState } | null;
  version: number;
  createdAt: string;
}

export const STATE_LABEL: Record<NoticeState, string> = {
  draft: "Draft",
  ready: "Ready",
  submitted: "Submitted",
  ack_pending: "Awaiting 277CA",
  ack_accepted: "Accepted",
  ack_rejected: "Rejected",
  cancelled: "Cancelled",
};

export const STATE_TONE: Record<NoticeState, StatusTone> = {
  draft: "neutral",
  ready: "progress",
  submitted: "progress",
  ack_pending: "progress",
  ack_accepted: "success",
  ack_rejected: "error",
  cancelled: "neutral",
};

export const ACTION_LABEL: Record<TransferNotice["action"], string> = {
  original: "Transfer notice",
  correction: "Date correction",
  void: "Void (8xD)",
};

/** The worklist's status line: Held / Ready / filed state — the hold is the first thing a biller needs. */
export function statusOf(n: TransferNotice): { label: string; tone: StatusTone } {
  if ((n.state === "draft" || n.state === "ready") && n.blockers.length > 0) {
    const held = n.blockers.some((b) => b.code === "PRIOR_BILLING_NOT_CONFIRMED");
    return { label: held ? "Held for prior hospice" : "Blocked", tone: "warning" };
  }
  if (
    n.state === "ack_accepted" &&
    n.followUp?.action === "void" &&
    n.followUp.state === "ack_accepted"
  )
    return { label: "Voided", tone: "neutral" };
  if (
    n.latestSubmissionOutcome === "failed_portal" ||
    n.latestSubmissionOutcome === "failed_worker"
  )
    if (n.state === "ready") return { label: "Send failed", tone: "error" };
  return { label: STATE_LABEL[n.state], tone: STATE_TONE[n.state] };
}

export const PATIENT_STATUS_OPTIONS = [
  { value: "50", label: "50 — Discharged to hospice (home)" },
  { value: "51", label: "51 — Discharged to hospice (medical facility)" },
] as const;

export interface ConfirmDraft {
  throughDate: string;
  patientStatus: "" | "50" | "51";
  ccn: string;
  npi: string;
}

const CCN_RE = /^[0-9A-Z]{6}$/;
const NPI_RE = /^[0-9]{10}$/;

/** Field errors for the prior-billing confirmation. A Through date ≠ the transfer date is allowed through: the
 *  server records it and reports the CONTINUITY_GAP blocker with the rule's own words. */
export function validateConfirm(
  d: ConfirmDraft,
  needs: { ccn: boolean; npi: boolean },
): Partial<Record<keyof ConfirmDraft, string>> {
  const e: Partial<Record<keyof ConfirmDraft, string>> = {};
  if (!d.throughDate)
    e.throughDate = "Enter the Through date on the transferring hospice's final claim.";
  if (!d.patientStatus) e.patientStatus = "Select the patient status on that claim.";
  if (needs.ccn && d.ccn && !CCN_RE.test(d.ccn))
    e.ccn = "A CCN is 6 characters: digits or capital letters.";
  if (needs.npi && d.npi && !NPI_RE.test(d.npi)) e.npi = "An NPI is 10 digits.";
  return e;
}

export function validateCorrection(corrected: string, onFile: string): string | null {
  if (!corrected) return "Enter the correct transfer date.";
  if (corrected === onFile) return "That is the date already on file.";
  return null;
}

/** A short, human date (UTC calendar date — these are date-only fields). */
export function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return y && m && d ? `${m}/${d}/${y}` : iso;
}

/** The error code out of the API's error envelope (`{ error: { code } }`). */
export function errorCode(err: unknown): string | undefined {
  const env = err as { error?: { code?: unknown } } | undefined;
  return typeof env?.error?.code === "string" ? env.error.code : undefined;
}

/** The API's message, falling back to a plain sentence. */
export function errorMessage(err: unknown, fallback: string): string {
  const env = err as { error?: { message?: unknown } } | undefined;
  return typeof env?.error?.message === "string" && env.error.message.length > 0
    ? env.error.message
    : fallback;
}
