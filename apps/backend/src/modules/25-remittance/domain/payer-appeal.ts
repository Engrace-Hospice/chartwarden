import { APPEAL_TRANSITIONS } from "./appeal-machine";
// M25 milestone 12a-1 - the PAYER APPEAL CASE (hospice ADR/TPE/QIC PRD, milestone 12). PURE.
//
// One case per level of a payer's own path. A deadline is computed ONLY from a complete level window (the path row, as a
// person wrote it) and an anchor date a person typed from the notice; nothing Medicare is applied unless the row says so (no
// 5-day presumption, no holiday roll-back): the presumption is whatever the row states or none, and the roll direction is
// the row's. With no window or no anchor date nothing is computed and the case reads "no due date" until a person types a
// recorded deadline. The only numbers in this file are validation and alert-threshold values marked `bound`.
import {
  DEFAULT_DEADLINE_ZONE,
  MS_PER_DAY,
  isoDay,
  nextBusinessDay,
  parseNoticeDay,
  previousBusinessDay,
} from "./deadline";
import { DISPOSITION_KINDS } from "./later-tier";
import { LEVEL_KINDS, type LevelWindow } from "./payer-appeal-path";
import { deriveRecordedDeadline } from "./recorded-deadline";
import type { AppealState } from "./types";

export type { LevelWindow } from "./payer-appeal-path";

/** The Medicare appeal states minus `escalated` (a QIC-to-OMHA move that has no payer equivalent). */
export const PAYER_APPEAL_STATES = [
  "draft",
  "submitted",
  "under_review",
  "decided",
  "withdrawn",
  "closed",
] as const;
export type PayerAppealState = (typeof PAYER_APPEAL_STATES)[number];

export const PAYER_DECISION_OUTCOMES = ["favorable", "partial", "unfavorable"] as const;

/** Days a draft may sit with no due date of either kind before the one `payer_appeal.no_deadline` alert (product to confirm). */
export const PAYER_APPEAL_NO_DEADLINE_ALERT_DAYS = 2; // bound: alert threshold, not a payer rule

export function canTransitionPayerAppeal(from: PayerAppealState, to: PayerAppealState): boolean {
  if (to === ("escalated" as string)) return false;
  return APPEAL_TRANSITIONS[from as AppealState]?.includes(to as AppealState) ?? false;
}

export const isPayerAppealTerminal = (state: PayerAppealState): boolean =>
  state === "closed" || state === "withdrawn";

export type PayerKindRefusal = "MEDICARE_PAYER" | "MEDICAID_PAYER" | "NO_PAYER_ADVICE";

/**
 * The program guard on the payer side: a Medicare denial takes the Medicare tiers, a Medicaid one is milestone 11's, and a
 * denial with no remittance advice names no payer to look a path up for. (The mirror refusal on `createAppeal` is deferred
 * until the milestone 11 guard merges.)
 */
export function checkPayerKind(adviceKind: string | null | undefined): PayerKindRefusal | null {
  if (adviceKind === null || adviceKind === undefined) return "NO_PAYER_ADVICE";
  if (adviceKind === "medicare") return "MEDICARE_PAYER";
  if (adviceKind === "medicaid") return "MEDICAID_PAYER";
  return null;
}

export interface PayerLevelDeadline {
  readonly anchorDay: string;
  /** null = the level states no presumption, so none was applied. */
  readonly presumedReceiptOn: string | null;
  readonly windowDays: number;
  readonly calendarLastDay: string;
  readonly lastFilingDay: string;
  readonly deadlineAt: Date;
  readonly zone: string;
}

/**
 * The filing deadline a complete level window yields for a typed anchor date, or null when there is no window, no date, or
 * the row is internally incomplete (a business basis with no roll stated). The day ends at the last millisecond of the
 * filing day in the earliest-ending provider zone. Throws on a typed date that is not a real day (the caller validates first).
 */
export function derivePayerLevelDeadline(
  window: LevelWindow | null,
  anchorDay: string | null,
  zones: readonly string[],
): PayerLevelDeadline | null {
  if (window === null || anchorDay === null) return null;
  const business = window.dayBasis === "business_us_federal";
  if (business === (window.roll === null)) return null;
  const anchorMs = parseNoticeDay(anchorDay);
  const presumption = window.receiptPresumptionDays;
  const receiptMs = anchorMs + (presumption ?? 0) * MS_PER_DAY;
  const calendarLastMs = receiptMs + window.windowDays * MS_PER_DAY;
  const lastMs =
    window.roll === "back"
      ? previousBusinessDay(calendarLastMs)
      : window.roll === "forward"
        ? nextBusinessDay(calendarLastMs)
        : calendarLastMs;
  const end = deriveRecordedDeadline(
    isoDay(lastMs),
    zones.length > 0 ? zones : [DEFAULT_DEADLINE_ZONE],
  );
  return {
    anchorDay,
    presumedReceiptOn: presumption === null ? null : isoDay(receiptMs),
    windowDays: window.windowDays,
    calendarLastDay: isoDay(calendarLastMs),
    lastFilingDay: isoDay(lastMs),
    deadlineAt: end.dueAt,
    zone: end.zone,
  };
}

export type PayerDeadlineState = "computed" | "recorded" | "none";

/** Where a case's due date comes from; `none` is a visible prompt, never a default. */
export function payerDeadlineState(input: {
  readonly computedAt: Date | null;
  readonly openRecordedCount: number;
}): PayerDeadlineState {
  if (input.computedAt !== null) return "computed";
  return input.openRecordedCount > 0 ? "recorded" : "none";
}

/**
 * INFORMATIONAL: the payer's decision days (as the path row recorded them) have passed since the filing was submitted and no
 * decision is recorded. Counts calendar days from the submission day; it escalates nothing.
 */
export function payerDecisionOverdue(input: {
  readonly decisionDays: number | null;
  readonly submittedOn: string | null;
  readonly state: string;
  readonly today: string;
}): boolean {
  if (input.decisionDays === null || input.submittedOn === null) return false;
  if (input.state !== "submitted" && input.state !== "under_review") return false;
  const dueMs = parseNoticeDay(input.submittedOn) + input.decisionDays * MS_PER_DAY;
  return parseNoticeDay(input.today) > dueMs;
}

/** An open draft with no due date of either kind past the threshold raises ONE alert. */
export function shouldAlertPayerNoDeadline(
  row: {
    readonly state: string;
    readonly createdAt: Date;
    readonly hasDeadline: boolean;
    readonly alreadyAlerted: boolean;
  },
  now: Date,
): boolean {
  if (row.hasDeadline || row.alreadyAlerted || row.state !== "draft") return false;
  return (
    now.getTime() - row.createdAt.getTime() >= PAYER_APPEAL_NO_DEADLINE_ALERT_DAYS * MS_PER_DAY
  );
}

export type PayerOpenRefusal = "LEVEL_LABEL_REQUIRED" | "LEVEL_KIND_INVALID";

/** With no path level chosen, the person names the level and its kind; a path level supplies both. */
export function checkPayerOpen(input: {
  readonly hasPathLevel: boolean;
  readonly levelLabel?: string;
  readonly levelKind?: string;
}): PayerOpenRefusal | null {
  if (input.hasPathLevel) return null;
  if ((input.levelLabel ?? "").trim() === "") return "LEVEL_LABEL_REQUIRED";
  if (!(LEVEL_KINDS as readonly string[]).includes(input.levelKind ?? ""))
    return "LEVEL_KIND_INVALID";
  return null;
}

export type PayerDecisionRefusal =
  | "OUTCOME_REQUIRED"
  | "DISPOSITION_INVALID"
  | "DISPOSITION_KIND_REQUIRED"
  | "DISPOSITION_NOTE_REQUIRED";

const present = (v: unknown): boolean => v !== undefined && v !== null && v !== "";

/** A decision carries an outcome; a disposition is a label (remand, dismissal, other) that spawns nothing. */
export function checkPayerDecision(input: {
  readonly outcome?: string;
  readonly dispositionKind?: string | null;
  readonly dispositionNote?: string | null;
}): PayerDecisionRefusal | null {
  if (!(PAYER_DECISION_OUTCOMES as readonly string[]).includes(input.outcome ?? "")) {
    return "OUTCOME_REQUIRED";
  }
  if (present(input.dispositionKind)) {
    if (!(DISPOSITION_KINDS as readonly string[]).includes(input.dispositionKind as string)) {
      return "DISPOSITION_INVALID";
    }
    if (input.dispositionKind === "other" && !present(input.dispositionNote)) {
      return "DISPOSITION_NOTE_REQUIRED";
    }
  } else if (present(input.dispositionNote)) {
    return "DISPOSITION_KIND_REQUIRED";
  }
  return null;
}
