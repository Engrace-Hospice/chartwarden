// apps/web/src/modules/08-encounters — the visit-note closure rules the supervisor board and the policy screen share (ADR-0113).
// Pure leaf: no React, no client. The SERVER is the authority for every bound here (the override service and the policy service enforce
// them); the shared bounds come from @chartwarden/types, the one place the server and this screen both read them from, so a form can
// refuse an obviously invalid entry before a round trip without a second copy to drift. The stage / deadline of a note is never computed
// here: the board shows what the server's clock decided.
import {
  CLOSURE_OVERRIDE_MAX_HOURS,
  DOCUMENTATION_OBLIGATION_MAX_THRESHOLD_HOURS,
  DOCUMENTATION_OBLIGATION_MIN_THRESHOLD_HOURS,
  DOCUMENTATION_OBLIGATION_MODES,
  type DocumentationObligationMode,
} from "@chartwarden/types";
import type { StatusTone } from "@chartwarden/ui";
import { formatClosureInstant } from "../../shell/closure-instant";

/** The stages a note on the supervisor's board can be in (an `ok` note is not on it). */
export type ClosureStage = "at_risk" | "overdue" | "escalated";
/** Every stage the server's clock can put an open note in: the board's three, plus `ok` (On track) on the author's own list. */
export type NoteStage = "ok" | ClosureStage;
export type ClosureMode = DocumentationObligationMode;

/** The shortest override window the form accepts (the longest and the default are the shared bounds). */
export const OVERRIDE_MIN_HOURS = 1;
/** Hours before the deadline when a clinician is first warned (the server's AT_RISK_LEAD_HOURS in note-clock.ts): copy only. */
export const WARNING_LEAD_HOURS = 6;

const MS_PER_HOUR = 3_600_000;

export const STAGE_LABEL: Readonly<Record<NoteStage, string>> = {
  ok: "On track",
  at_risk: "At risk",
  overdue: "Overdue",
  escalated: "Escalated",
};

/** A pill carries its meaning in the label (never colour alone); the tone only ranks the stages (calm, then warning, then error). */
export const STAGE_TONE: Readonly<Record<NoteStage, StatusTone>> = {
  ok: "neutral",
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

export const MODE_ORDER: readonly ClosureMode[] = DOCUMENTATION_OBLIGATION_MODES;

export function isClosureMode(value: string): value is ClosureMode {
  return (DOCUMENTATION_OBLIGATION_MODES as readonly string[]).includes(value);
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
  return wholeNumberInRange(text, OVERRIDE_MIN_HOURS, CLOSURE_OVERRIDE_MAX_HOURS);
}

/** The deadline threshold of the policy: a whole number from 1 to 168, or null. */
export function parseThresholdHours(text: string): number | null {
  return wholeNumberInRange(
    text,
    DOCUMENTATION_OBLIGATION_MIN_THRESHOLD_HOURS,
    DOCUMENTATION_OBLIGATION_MAX_THRESHOLD_HOURS,
  );
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

/** A grant is in force until its expiry (strictly before), unless revoked: the same rule as the server's `isOverrideActive`. */
export function isGrantActive(
  grant: { readonly expiresAt: string; readonly revokedAt: string | null },
  now: Date,
): boolean {
  return grant.revokedAt === null && now.getTime() < new Date(grant.expiresAt).getTime();
}

/**
 * What the drawer's status line says about the grant it holds for this clinician, or null when there is nothing to say (no grant, or one
 * that simply ran out). A revoke that leaves ANOTHER grant in force does not limit the clinician again, so it says that instead.
 */
export function overrideStatusText(
  grant: {
    readonly expiresAt: string;
    readonly revokedAt: string | null;
    readonly remainingActiveUntil?: string | null;
  } | null,
  clinicianName: string,
  now: Date,
): string | null {
  if (grant === null) return null;
  if (isGrantActive(grant, now)) {
    return `${clinicianName} is not blocked until ${formatClosureInstant(grant.expiresAt)}.`;
  }
  if (grant.revokedAt === null) return null;
  return grant.remainingActiveUntil
    ? `Override revoked. Another override for this clinician is still active until ${formatClosureInstant(grant.remainingActiveUntil)}.`
    : `Override revoked. ${clinicianName} is limited again while the note is past its deadline.`;
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
