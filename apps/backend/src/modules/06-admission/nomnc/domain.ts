// apps/backend/src/modules/06-admission/nomnc/domain.ts — milestone 10a (hospice ADR/TPE/QIC appeals PRD): the pure
// domain of NOMNC delivery records and BFCC-QIO expedited reviews. RECORD-KEEPING ONLY. No CMS / QIO / NOMNC
// duration, time of day, delivery or signature rule is encoded here: every clock is typed by a person (local date AND
// time, plus a mandatory source note), every closed set below is a LABEL that implies no rule, and every prompt names a
// missing fact, never a value. No IO and no `Date.now()`: `now` is always passed in.
import { ChartWardenError } from "@chartwarden/types";
import { wallTimeToOrgInstant } from "../certification/window-math";

// ── label sets (text + CHECK in the migration; no pgEnum — enums are irreversible) ───────────────────────────────

export const RECIPIENT_KINDS = ["beneficiary", "representative"] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];

export const ACKNOWLEDGEMENT_KINDS = ["signed", "refused", "other"] as const;
export type AcknowledgementKind = (typeof ACKNOWLEDGEMENT_KINDS)[number];

export const NOTICE_STATUSES = ["active", "superseded", "withdrawn"] as const;
export type NoticeStatus = (typeof NOTICE_STATUSES)[number];

export const REVIEW_STATES = ["open", "decided", "withdrawn"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

export const REQUESTED_BY_KINDS = ["beneficiary", "representative", "unknown"] as const;
export type RequestedByKind = (typeof REQUESTED_BY_KINDS)[number];

export const DEADLINE_KINDS = [
  "appeal_request",
  "denc_delivery",
  "records_to_qio",
  "qio_decision",
  "other",
] as const;
export type DeadlineKind = (typeof DEADLINE_KINDS)[number];

/** Kinds that belong to a notice / to a review (a label grouping, not a rule). */
export const NOTICE_DEADLINE_KINDS: readonly DeadlineKind[] = ["appeal_request", "other"];
export const REVIEW_DEADLINE_KINDS: readonly DeadlineKind[] = [
  "denc_delivery",
  "records_to_qio",
  "qio_decision",
  "other",
];

export const DECISION_OUTCOMES = ["discharge_upheld", "discharge_reversed", "other"] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

/**
 * The discharge reasons that PROMPT staff to record a NOMNC. SME-UNCONFIRMED: the set is ADR-0015 D5's wording
 * ("for a `no_longer_terminal` or `for_cause` live discharge, a NOMNC is issued with appeal rights"); the PRD's SME
 * item 3 has not confirmed `for_cause` nor the exclusion of transfer / moved-out-of-area. It only drives a
 * non-blocking prompt; route 39 never reads it.
 */
export const NOMNC_PROMPT_REASONS: readonly string[] = ["no_longer_terminal", "for_cause"];

/**
 * Hours-before-due at which an unsatisfied deadline alerts, tightest last. A PRODUCT timing, not a CMS figure
 * (plan decision 4; needs product confirmation). The 15-minute cron means an alert can arrive up to 15 minutes late.
 * ponytail: 15-min cron granularity; a delayed job via BullMQ if tighter is needed.
 */
export const EXPEDITED_ALERT_BOUNDARY_HOURS: readonly number[] = [24, 4, 1];

/** Display-only: a deadline within this many hours reads "due soon". Not a rule, not used by alerts. */
export const DUE_SOON_DISPLAY_HOURS = 24;

// ── refusals ─────────────────────────────────────────────────────────────────────────────────────────────

export type NomncRefusalCode =
  | "SOURCE_NOTE_REQUIRED"
  | "DATE_REQUIRED"
  | "TIME_REQUIRED"
  | "DATE_INVALID"
  | "TIME_INVALID"
  | "TIME_NONEXISTENT"
  | "DELIVERED_IN_FUTURE"
  | "REPRESENTATIVE_NAME_REQUIRED"
  | "ACK_NOTE_REQUIRED"
  | "OTHER_LABEL_REQUIRED"
  | "DECISION_NOTE_REQUIRED"
  | "REVIEW_ALREADY_OPEN"
  | "REVIEW_NOT_OPEN"
  | "NOTICE_NOT_ACTIVE"
  | "ACTIVE_NOTICE_EXISTS"
  | "REVIEW_STILL_OPEN"
  | "WITHDRAW_REASON_REQUIRED"
  | "QIO_NAME_REQUIRED"
  | "DOCUMENT_VERSION_REQUIRED"
  | "DEADLINE_ALREADY_RECORDED"
  | "DEADLINE_SATISFIED"
  | "DEADLINE_KIND_NOT_ALLOWED"
  | "VERSION_CONFLICT";

const CONFLICT_CODES: ReadonlySet<NomncRefusalCode> = new Set([
  "REVIEW_ALREADY_OPEN",
  "REVIEW_NOT_OPEN",
  "NOTICE_NOT_ACTIVE",
  "ACTIVE_NOTICE_EXISTS",
  "REVIEW_STILL_OPEN",
  "DEADLINE_ALREADY_RECORDED",
  "DEADLINE_SATISFIED",
  "VERSION_CONFLICT",
]);

/** A reason-coded refusal. 409 for a state or concurrency conflict, 422 for a missing / invalid fact. */
export class NomncRuleError extends ChartWardenError {
  declare readonly code: NomncRefusalCode;
  constructor(refusal: NomncRefusalCode, message: string) {
    super(refusal, message, CONFLICT_CODES.has(refusal) ? 409 : 422);
    this.name = "NomncRuleError";
  }
}

const conflict = (code: NomncRefusalCode, message: string) => new NomncRuleError(code, message);

// ── typed facts ──────────────────────────────────────────────────────────────────────────────────────────

/** A source note is mandatory on every typed fact: a date nobody can trace is not recorded. */
export function requireSourceNote(note: string | null | undefined): string {
  const trimmed = note?.trim() ?? "";
  if (trimmed === "") {
    throw new NomncRuleError("SOURCE_NOTE_REQUIRED", "a source note is required (where the date came from)");
  }
  return trimmed;
}

const WALL_MESSAGES = {
  DATE_REQUIRED: "enter the date as printed on the notice or told by the QIO",
  TIME_REQUIRED: "enter the time of day as well as the date; a time is never assumed",
  DATE_INVALID: "that date does not exist",
  TIME_INVALID: "the time must be HH:MM in 24-hour form",
  TIME_NONEXISTENT: "that local time does not exist on that date in the organization's time zone",
} as const;

/** A typed local date + time -> an instant in the org zone, plus the `YYYY-MM-DDTHH:MM` echo shown back. */
export function resolveTypedInstant(
  date: string | null | undefined,
  time: string | null | undefined,
  timeZone: string,
): { readonly instant: Date; readonly dueLocal: string } {
  const r = wallTimeToOrgInstant(date, time, timeZone);
  if (!r.ok) throw new NomncRuleError(r.code, WALL_MESSAGES[r.code]);
  return { instant: new Date(r.instant), dueLocal: `${date}T${time}` };
}

export interface NoticeFactsInput {
  readonly deliveredAt: Date;
  readonly now: Date;
  readonly recipientKind: RecipientKind;
  readonly representativeName: string | null | undefined;
  readonly acknowledgementKind: AcknowledgementKind | null | undefined;
  readonly acknowledgementNote: string | null | undefined;
}

/** The shape rules the DB CHECKs repeat; they are facts about what was recorded, not CMS requirements. */
export function validateNoticeFacts(input: NoticeFactsInput): void {
  if (input.deliveredAt.getTime() > input.now.getTime()) {
    throw new NomncRuleError("DELIVERED_IN_FUTURE", "delivery cannot be recorded in the future");
  }
  if (input.recipientKind === "representative" && !input.representativeName?.trim()) {
    throw new NomncRuleError("REPRESENTATIVE_NAME_REQUIRED", "name the representative who received the notice");
  }
  const kind = input.acknowledgementKind;
  if ((kind === "refused" || kind === "other") && !input.acknowledgementNote?.trim()) {
    throw new NomncRuleError("ACK_NOTE_REQUIRED", `a note is required when the acknowledgement is "${kind}"`);
  }
}

export function requireOtherLabel(kind: DeadlineKind, label: string | null | undefined): string | null {
  if (kind !== "other") return null;
  const trimmed = label?.trim() ?? "";
  if (trimmed === "") {
    throw new NomncRuleError("OTHER_LABEL_REQUIRED", 'a label is required for a deadline of kind "other"');
  }
  return trimmed;
}

// ── review state machine ─────────────────────────────────────────────────────────────────────────────────

export type ReviewEvent =
  | {
      readonly kind: "decide";
      readonly outcome: DecisionOutcome;
      readonly receivedAt: Date | null | undefined;
      readonly note: string | null | undefined;
    }
  | { readonly kind: "withdraw" };

/** `open -> decided`, `open -> withdrawn`; nothing leaves `decided` / `withdrawn`. */
export function planReviewDecision(state: ReviewState, event: ReviewEvent): ReviewState {
  if (state !== "open") {
    throw conflict("REVIEW_NOT_OPEN", `the review is ${state}; only an open review can change state`);
  }
  if (event.kind === "withdraw") return "withdrawn";
  if (!event.receivedAt) {
    throw new NomncRuleError("DATE_REQUIRED", "record when the decision was received");
  }
  if (event.outcome === "other" && !event.note?.trim()) {
    throw new NomncRuleError("DECISION_NOTE_REQUIRED", 'a note is required when the outcome is "other"');
  }
  return "decided";
}

// ── derived status (never stored) ────────────────────────────────────────────────────────────────────────

/** `closed`: the deadline's notice was superseded / withdrawn or its review decided / withdrawn: it no longer runs. */
export type DeadlineStatus = "open" | "due_soon" | "past" | "satisfied" | "closed";

export function deadlineStatus(
  row: { readonly dueAt: Date; readonly satisfiedAt: Date | null },
  now: Date,
  live = true,
): DeadlineStatus {
  if (row.satisfiedAt) return "satisfied";
  if (!live) return "closed";
  const hours = (row.dueAt.getTime() - now.getTime()) / 3_600_000;
  if (hours < 0) return "past";
  return hours <= DUE_SOON_DISPLAY_HOURS ? "due_soon" : "open";
}

// ── alert selection ──────────────────────────────────────────────────────────────────────────────────────

export interface ExpeditedAlertRow {
  readonly id: string;
  readonly dueAt: Date;
  readonly satisfiedAt: Date | null;
  readonly lastAlertedBoundaryHours: number | null;
  readonly overdueAlertedAt: Date | null;
}

export type ExpeditedAlertSelection =
  | { readonly id: string; readonly kind: "approaching"; readonly boundaryHours: number }
  | { readonly id: string; readonly kind: "overdue" };

/**
 * At most one alert per deadline per tick: the tightest boundary newly crossed (a missed tick skips the wider ones
 * rather than paging for each), or the one-time overdue alert. A boundary already alerted is never repeated and a
 * satisfied deadline never alerts. The caller persists the mark in the same transaction as the publish.
 */
export function selectExpeditedAlerts(
  rows: readonly ExpeditedAlertRow[],
  now: Date,
): ExpeditedAlertSelection[] {
  const out: ExpeditedAlertSelection[] = [];
  for (const row of rows) {
    if (row.satisfiedAt) continue;
    const hoursLeft = (row.dueAt.getTime() - now.getTime()) / 3_600_000;
    if (hoursLeft < 0) {
      if (!row.overdueAlertedAt) out.push({ id: row.id, kind: "overdue" });
      continue;
    }
    const last = row.lastAlertedBoundaryHours ?? Number.POSITIVE_INFINITY;
    const crossed = EXPEDITED_ALERT_BOUNDARY_HOURS.filter((b) => hoursLeft <= b && b < last);
    if (crossed.length > 0) {
      out.push({ id: row.id, kind: "approaching", boundaryHours: Math.min(...crossed) });
    }
  }
  return out;
}

// ── prompts (a list of what is MISSING, never a value) ───────────────────────────────────────────────────

export type PromptCode =
  | "NO_NOTICE"
  | "NO_APPEAL_DEADLINE"
  | "NO_ACKNOWLEDGEMENT"
  | "NO_COPY"
  | "REVIEW_OPEN"
  | "REVIEW_REVERSED"
  | "NO_DENC_DEADLINE"
  | "NO_RECORDS_DEADLINE"
  | "NO_DECISION_DEADLINE";

export interface Prompt {
  readonly code: PromptCode;
  readonly severity: "warn" | "info";
  readonly message: string;
}

export interface PromptInput {
  readonly notice: {
    readonly acknowledgementKind: AcknowledgementKind | null;
    readonly documentId: string | null;
  } | null;
  readonly review: {
    readonly state: ReviewState;
    readonly decisionOutcome: DecisionOutcome | null;
  } | null;
  readonly deadlines: readonly { readonly subject: "notice" | "review"; readonly kind: DeadlineKind }[];
  readonly dischargeReason?: string | undefined;
}

export function promptsFor(input: PromptInput): Prompt[] {
  const { notice, review, deadlines } = input;
  const has = (subject: "notice" | "review", kind: DeadlineKind) =>
    deadlines.some((d) => d.subject === subject && d.kind === kind);
  const out: Prompt[] = [];
  if (!notice) {
    if (input.dischargeReason && NOMNC_PROMPT_REASONS.includes(input.dischargeReason)) {
      out.push({ code: "NO_NOTICE", severity: "warn", message: "No NOMNC delivery recorded." });
    }
    return out;
  }
  if (!has("notice", "appeal_request")) {
    out.push({
      code: "NO_APPEAL_DEADLINE",
      severity: "warn",
      message: "No deadline recorded: enter it from the notice.",
    });
  }
  if (!notice.acknowledgementKind) {
    out.push({
      code: "NO_ACKNOWLEDGEMENT",
      severity: "info",
      message: "Signature or refusal not recorded.",
    });
  }
  if (!notice.documentId) {
    out.push({ code: "NO_COPY", severity: "info", message: "No copy of the notice attached." });
  }
  if (review?.state === "open") {
    out.push({ code: "REVIEW_OPEN", severity: "warn", message: "QIO review open." });
    const missing: [DeadlineKind, PromptCode, string][] = [
      ["denc_delivery", "NO_DENC_DEADLINE", "No DENC deadline recorded: enter it from the QIO's call."],
      ["records_to_qio", "NO_RECORDS_DEADLINE", "No records deadline recorded: enter it from the QIO's call."],
      ["qio_decision", "NO_DECISION_DEADLINE", "No decision deadline recorded: enter it from the QIO's call."],
    ];
    for (const [kind, code, message] of missing) {
      if (!has("review", kind)) out.push({ code, severity: "warn", message });
    }
  }
  if (review?.state === "decided" && review.decisionOutcome === "discharge_reversed") {
    out.push({ code: "REVIEW_REVERSED", severity: "warn", message: "QIO reversed the discharge." });
  }
  return out;
}
