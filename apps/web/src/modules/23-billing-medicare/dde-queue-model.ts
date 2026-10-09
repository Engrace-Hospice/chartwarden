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
  | "record_acceptance"
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
  /** The closed item the filing-window watch re-queued, if this item is such a respawn. */
  respawnedFromId?: string | null;
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

/** The detail response: the item plus its append-only history. */
export type DdeItemDetail = DdeItem & { events: DdeEvent[] };

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

/** The badge on an item the filing-window watch re-queued after an earlier item was closed. */
export const REQUEUED_LABEL = "Re-queued after closure";

/** Said beside Close: closing is not the end while the notice is still unaccepted. */
export const CLOSE_REQUEUE_NOTE =
  "While the notice is still unaccepted, the filing-window watch re-queues a closed item (within about 30 minutes). Cancel an item before it is submitted to stop that.";

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
const DCN_RE = /^[A-Za-z0-9]{13,23}$/;
const RTP_RE = /^[A-Z0-9]{1,8}$/;

const MBI_ALPHA = "[AC-HJKMNP-RT-Y~]";
const MBI_ALNUM = "[AC-HJKMNP-RT-Y0-9~#]";
const MBI_DIGIT = "[0-9#]";
const MBI_WINDOW = new RegExp(
  `[1-9#]${MBI_ALPHA}${MBI_ALNUM}${MBI_DIGIT}${MBI_ALPHA}${MBI_ALNUM}${MBI_DIGIT}${MBI_ALPHA}${MBI_ALPHA}${MBI_DIGIT}${MBI_DIGIT}`,
  "i",
);

function squash(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFKD").replace(/\p{M}/gu, "")) {
    if (/[A-Za-z0-9]/.test(ch)) out += ch;
    else if (/\p{N}/u.test(ch)) out += "#";
    else if (/\p{L}/u.test(ch)) out += "~";
  }
  return out;
}

/**
 * Best-effort mirror of the server's note screen (`looksLikeMbi` in @wardenx/billing): NFKD-normalise, drop marks and
 * everything that is not a letter or digit, turn a non-ASCII lookalike into a wildcard of its own kind (a letter where
 * the MBI has a letter, a numeral where it has a digit), and look for any MBI-shaped 11-character window. A letter
 * lookalike for a DIGIT (Cyrillic Ze for 3) is a known, accepted gap. The server is the authority; this only stops
 * the obvious case before a request is sent. Both screens are pinned by one shared vector table.
 */
export function looksLikeMbi(text: string): boolean {
  return MBI_WINDOW.test(squash(text));
}

const NOTES_MBI_MESSAGE = "Notes cannot contain a Medicare number (MBI). Remove it.";

function notesError(notes: string): string | undefined {
  if (notes.length > NOTES_MAX) return `Keep notes under ${NOTES_MAX} characters.`;
  if (looksLikeMbi(notes)) return NOTES_MBI_MESSAGE;
  return undefined;
}

function dcnError(dcn: string): string | undefined {
  if (!dcn) return undefined;
  if (!DCN_RE.test(dcn)) return "A DCN / ICN is 13 to 23 letters and digits.";
  if (looksLikeMbi(dcn)) return "That looks like a Medicare number. Enter the DCN / ICN instead.";
  return undefined;
}

export function validateSubmission(
  d: SubmissionDraft,
): Partial<Record<keyof SubmissionDraft, string>> {
  const e: Partial<Record<keyof SubmissionDraft, string>> = {};
  const dcn = dcnError(d.dcn);
  if (dcn) e.dcn = dcn;
  const notes = notesError(d.notes);
  if (notes) e.notes = notes;
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
  if (d.macAcceptedOn && !isRealDate(d.macAcceptedOn)) e.macAcceptedOn = "Enter a real date.";
  if (d.outcome === "returned" && !d.rtpReasonCode) e.rtpReasonCode = "Enter the RTP reason code.";
  if (d.rtpReasonCode && !RTP_RE.test(d.rtpReasonCode))
    e.rtpReasonCode = "Capital letters and digits only, up to 8 characters.";
  const dcn = dcnError(d.dcn);
  if (dcn) e.dcn = dcn;
  const notes = notesError(d.notes);
  if (notes) e.notes = notes;
  return e;
}

/** True for a real calendar date written `YYYY-MM-DD` (2026-02-31 is not one). */
export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (Number(value.slice(0, 4)) < 1) return false; // Postgres has no year 0
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** "1 item" / "2 items". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A local date-time for a timestamp (the browser's zone); date-only fields use {@link fmtDay}. */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
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
