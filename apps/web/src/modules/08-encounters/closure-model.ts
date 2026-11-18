// apps/web/src/modules/08-encounters — the visit-note closure rules the supervisor board and the policy screen share (ADR-0113).
// Pure leaf: no React, no client. The SERVER is the authority for every bound here (the override service and the policy service repeat
// them); these constants only let a form refuse an obviously invalid entry before a round trip, and they are named so a drift against the
// server is one line to find. The stage / deadline of a note is never computed here: the board shows what the server's clock decided.
import type { StatusTone } from "@chartwarden/ui";

export type ClosureStage = "at_risk" | "overdue" | "escalated";
export type ClosureMode = "off" | "warn" | "block";

/** The reason an override records is audited: the server refuses anything shorter (override-service CLOSURE_OVERRIDE_MIN_REASON_CHARS). */
export const OVERRIDE_MIN_REASON_CHARS = 40;
export const OVERRIDE_MIN_HOURS = 1;
export const OVERRIDE_MAX_HOURS = 24;
export const OVERRIDE_DEFAULT_HOURS = 4;
export const POLICY_MIN_THRESHOLD_HOURS = 1;
export const POLICY_MAX_THRESHOLD_HOURS = 168;
/** Hours before the deadline when a clinician is first warned (the server's AT_RISK_LEAD_HOURS in note-clock.ts): copy only. */
export const WARNING_LEAD_HOURS = 6;
/** What a tenant with no policy row gets (the server's DEFAULT_CLOSURE_POLICY): warn after 24 hours. */
export const DEFAULT_POLICY_MODE: ClosureMode = "warn";
export const DEFAULT_POLICY_THRESHOLD_HOURS = 24;

const MS_PER_HOUR = 3_600_000;

export const STAGE_LABEL: Readonly<Record<ClosureStage, string>> = {
  at_risk: "At risk",
  overdue: "Overdue",
  escalated: "Escalated",
};

/** A pill carries its meaning in the label (never colour alone); the tone only ranks the three. */
export const STAGE_TONE: Readonly<Record<ClosureStage, StatusTone>> = {
  at_risk: "progress",
  overdue: "warning",
  escalated: "error",
};

export const MODE_LABEL: Readonly<Record<ClosureMode, string>> = {
  off: "Off",
  warn: "Warn only",
  block: "Warn, then block",
};

/** Plain-language effect of each mode, shown beside the choice so nobody picks one by its name alone. */
export const MODE_EFFECT: Readonly<Record<ClosureMode, string>> = {
  off: "Notes are not tracked against a deadline. No alerts are sent and nobody is limited.",
  warn: "Clinicians get an alert before and after the deadline, and supervisors see overdue notes. Nobody is limited.",
  block:
    "Alerts as in warn only, and a clinician whose note is past its deadline can only close notes and use patient-safety routes until it is closed or a supervisor grants a temporary override.",
};

export const MODE_ORDER: readonly ClosureMode[] = ["off", "warn", "block"];

export function isClosureMode(value: string): value is ClosureMode {
  return value === "off" || value === "warn" || value === "block";
}

/**
 * Whether saving `next` can start limiting clinicians who are not limited now, so the person confirms first: turning blocking on, or
 * shortening the deadline while it is on (a note older than the new deadline is overdue at once). Every other change limits no one.
 */
export function needsBlockConfirmation(
  current: { readonly mode: ClosureMode; readonly thresholdHours: number },
  next: { readonly mode: ClosureMode; readonly thresholdHours: number },
): boolean {
  if (next.mode !== "block") return false;
  return current.mode !== "block" || next.thresholdHours < current.thresholdHours;
}

/** The reason as the server will count it: trimmed (an all-space reason is no reason). */
export function reasonLength(reason: string): number {
  return reason.trim().length;
}

function wholeNumberInRange(text: string, min: number, max: number): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : null;
}

/** Hours of an override window: a whole number from 1 to 24, or null. */
export function parseOverrideHours(text: string): number | null {
  return wholeNumberInRange(text, OVERRIDE_MIN_HOURS, OVERRIDE_MAX_HOURS);
}

/** The deadline threshold of the policy: a whole number from 1 to 168, or null. */
export function parseThresholdHours(text: string): number | null {
  return wholeNumberInRange(text, POLICY_MIN_THRESHOLD_HOURS, POLICY_MAX_THRESHOLD_HOURS);
}

/** "<1h" under an hour, else whole hours ("5h"): the board sorts oldest first, so precision below an hour adds only noise. */
export function formatHours(hours: number): string {
  if (hours < 1) return "<1h";
  return `${Math.floor(hours)}h`;
}

/**
 * The timing cell of a row: an at-risk note counts down to its deadline (the server reports 0 hours overdue until the deadline
 * passes), an overdue or escalated one shows how long it has been overdue.
 */
export function timingLabel(
  stage: ClosureStage,
  hoursOverdue: number,
  deadlineAt: string,
  now: Date,
): string {
  if (stage !== "at_risk") return `${formatHours(hoursOverdue)} overdue`;
  const hoursLeft = (new Date(deadlineAt).getTime() - now.getTime()) / MS_PER_HOUR;
  return `Due in ${formatHours(Math.max(0, hoursLeft))}`;
}

/** An instant in the viewer's locale and time zone ("Nov 18, 3:40 PM"); an unparseable value is shown as a dash, never "Invalid Date". */
export function formatInstant(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** A grant is in force until its expiry (strictly before), unless revoked: the same rule as the server's `isOverrideActive`. */
export function isGrantActive(
  grant: { readonly expiresAt: string; readonly revokedAt: string | null },
  now: Date,
): boolean {
  return grant.revokedAt === null && now.getTime() < new Date(grant.expiresAt).getTime();
}

export interface StageCounts {
  readonly escalated: number;
  readonly overdue: number;
  readonly atRisk: number;
}

export function countByStage(items: readonly { readonly stage: ClosureStage }[]): StageCounts {
  const count = (stage: ClosureStage): number => items.filter((i) => i.stage === stage).length;
  return { escalated: count("escalated"), overdue: count("overdue"), atRisk: count("at_risk") };
}
