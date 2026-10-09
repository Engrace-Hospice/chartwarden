// apps/web/src/modules/23-billing-medicare — the pure model behind the DDE work queue (ADR-0052): the human
// work tracking for Medicare Direct Data Entry (FISS). Wire types (the generated client's DdeItemView), labels and
// tones, the deadline indicator, and the client-side checks of the three forms. The server re-evaluates everything
// (state machine, MBI screen, acceptance transition); these checks only keep an incomplete form from being sent.
// NO MBI is shown or sent from here, and notes are never logged.
import type { StatusTone } from "@wardenx/ui";

export type DdeItemType =
  | "noe"
  | "notr"
  | "claim_entry"
  | "rtp_correction"
  | "adjustment"
  | "cancel"
  | "adr_response";

export type DdeState =
  | "queued"
  | "assigned"
  | "in_progress"
  | "submitted"
  | "accepted"
  | "returned"
  | "closed"
  | "cancelled";

export type DdeDeadlineStatus = "none" | "on_track" | "at_risk" | "overdue" | "met" | "missed";

export type DdeAction =
  | "claim"
  | "assign"
  | "start"
  | "record_submission"
  | "record_outcome"
  | "retry"
  | "cancel"
  | "close";

export interface DdeItem {
  ddeWorkItemId: string;
  patientId: string;
  providerEntityId: string;
  itemType: DdeItemType;
  subjectKind: "claim" | "noe_record" | "notr_record";
  subjectId: string;
  state: DdeState;
  attemptNumber: number;
  assigneeMembershipId: string | null;
  priority: number;
  source: "manual" | "watchdog";
  deadlineAt: string | null;
  deadlineStatus: DdeDeadlineStatus;
  submittedAt: string | null;
  macAcceptedOn: string | null;
  dcn: string | null;
  rtpReasonCode: string | null;
  outcomeCode: string | null;
  notes: string | null;
  allowedActions: DdeAction[];
  version: number;
  createdAt: string;
}

export interface DdeEvent {
  eventId: string;
  event: string;
  fromState: string | null;
  toState: string;
  attemptNumber: number;
  occurredAt: string;
}

export const TYPE_LABEL: Record<DdeItemType, string> = {
  noe: "Notice of Election",
  notr: "Notice of Termination",
  claim_entry: "Claim entry",
  rtp_correction: "RTP correction",
  adjustment: "Adjustment",
  cancel: "Claim cancel",
  adr_response: "ADR response",
};

export const STATE_LABEL: Record<DdeState, string> = {
  queued: "Queued",
  assigned: "Assigned",
  in_progress: "In progress",
  submitted: "Keyed, awaiting answer",
  accepted: "Accepted",
  returned: "Returned",
  closed: "Closed",
  cancelled: "Cancelled",
};

export const STATE_TONE: Record<DdeState, StatusTone> = {
  queued: "neutral",
  assigned: "progress",
  in_progress: "progress",
  submitted: "warning",
  accepted: "success",
  returned: "error",
  closed: "neutral",
  cancelled: "neutral",
};

export const EVENT_LABEL: Record<string, string> = {
  create: "Queued",
  assign: "Assigned",
  reassign: "Reassigned",
  start: "Started",
  submit: "Recorded as keyed in DDE",
  accept: "Accepted",
  return: "Returned",
  retry: "Reopened",
  close: "Closed",
  cancel: "Cancelled",
};

export const DEADLINE_LABEL: Record<DdeDeadlineStatus, string> = {
  none: "No deadline",
  on_track: "On track",
  at_risk: "At risk",
  overdue: "Overdue",
  met: "Met",
  missed: "Missed",
};

export const DEADLINE_TONE: Record<DdeDeadlineStatus, StatusTone> = {
  none: "neutral",
  on_track: "neutral",
  at_risk: "warning",
  overdue: "error",
  met: "success",
  missed: "error",
};

/** True for the notice types whose deadline is met only by the MAC's recorded acceptance date. */
export function isNoticeType(t: DdeItemType): boolean {
  return t === "noe" || t === "notr";
}

/** What the deadline cell says: an NOE/NOTR that is keyed but not yet accepted is still at risk. */
export function deadlineNote(item: DdeItem): string {
  if (item.deadlineAt === null) return "";
  if (isNoticeType(item.itemType) && item.state === "submitted" && !item.macAcceptedOn)
    return "Keyed, but not met until the MAC acceptance date is recorded";
  return "";
}

export interface SubmissionDraft {
  dcn: string;
  notes: string;
}
export interface OutcomeDraft {
  outcome: "" | "accepted" | "returned";
  macAcceptedOn: string;
  rtpReasonCode: string;
  dcn: string;
  notes: string;
}

export const NOTES_MAX = 500;
const DCN_RE = /^[A-Za-z0-9]{1,23}$/;
const RTP_RE = /^[A-Z0-9]{1,8}$/;

export function validateSubmission(
  d: SubmissionDraft,
): Partial<Record<keyof SubmissionDraft, string>> {
  const e: Partial<Record<keyof SubmissionDraft, string>> = {};
  if (d.dcn && !DCN_RE.test(d.dcn)) e.dcn = "Letters and digits only, up to 23 characters.";
  if (d.notes.length > NOTES_MAX) e.notes = `Keep notes under ${NOTES_MAX} characters.`;
  return e;
}

export function validateOutcome(
  d: OutcomeDraft,
  item: DdeItem,
): Partial<Record<keyof OutcomeDraft, string>> {
  const e: Partial<Record<keyof OutcomeDraft, string>> = {};
  if (!d.outcome) e.outcome = "Choose what came back.";
  if (d.outcome === "accepted" && isNoticeType(item.itemType) && !d.macAcceptedOn)
    e.macAcceptedOn = "Enter the date the MAC accepted it, as DDE shows it.";
  if (d.outcome === "returned" && !d.rtpReasonCode) e.rtpReasonCode = "Enter the RTP reason code.";
  if (d.rtpReasonCode && !RTP_RE.test(d.rtpReasonCode))
    e.rtpReasonCode = "Capital letters and digits only, up to 8 characters.";
  if (d.dcn && !DCN_RE.test(d.dcn)) e.dcn = "Letters and digits only, up to 23 characters.";
  if (d.notes.length > NOTES_MAX) e.notes = `Keep notes under ${NOTES_MAX} characters.`;
  return e;
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
