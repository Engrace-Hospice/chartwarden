// apps/web/src/modules/08-encounters — the late-entry reason the visit-note composer asks for (Module 8 §2.5, D4). Pure leaf: no React, no client.
//
// The SERVER is the authority: it measures the note against the organization's local calendar day, reifies the tier and refuses a finalize
// that has no reason (422 LATE_ENTRY_REASON_REQUIRED). This file only decides WHEN to ask and WORDS the ask. The thresholds (the day
// ceilings, the 40-character minimum, which tiers need a reason) are the shared ones from @chartwarden/types that the server reads too, so
// there is no second definition to drift.
//
// ponytail: the day the composer measures against is the device's calendar day, because the browser is not told the organization's
// time zone. It differs from the server's day only when the device and the organization are in different zones near midnight; the
// server's refusal is still honoured (the box shows then too), and a box shown by mistake is harmless. If the encounter view ever
// carries the server's tier, read it here and drop the device day.
//
// The reason is clinical-adjacent free text: it lives in component state only, goes to the server in the finalize body and nowhere else
// (never a URL, a log, storage or an AI prompt: the note drafting reads the selections and records, not this).
import {
  LATE_ENTRY_REASON_MAX_CHARS,
  LATE_ENTRY_REASON_MIN_CHARS,
  LATE_ENTRY_REASON_TIERS,
  type LateEntryTier,
  calendarDaysBetween,
  lateEntryTierForDaysLate,
} from "@chartwarden/types";
import type { WriteResult } from "./encounters-api";

/** The wire code of the server's refusal of a finalize that carries no (or too short a) reason. */
export const LATE_ENTRY_REASON_REQUIRED_CODE = "LATE_ENTRY_REASON_REQUIRED";

export { LATE_ENTRY_REASON_MAX_CHARS, LATE_ENTRY_REASON_MIN_CHARS };

export interface LateEntryEstimate {
  readonly daysLate: number;
  readonly tier: LateEntryTier;
}

const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})/;

/** The device's calendar day as `YYYY-MM-DD` (local getters: the date the clinician sees on their own clock). */
export function localCalendarDay(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** How late a note for a visit on `serviceDate` is on `today`; null when either is not a calendar date (nothing is then guessed). */
export function estimateLateEntry(
  serviceDate: string | null | undefined,
  today: string,
): LateEntryEstimate | null {
  const visit =
    serviceDate !== null && serviceDate !== undefined ? CALENDAR_DAY.exec(serviceDate) : null;
  const day = CALENDAR_DAY.exec(today);
  if (!visit || !day) return null;
  const daysLate = calendarDaysBetween(visit[0], day[0]);
  // "2026-13-45" matches the shape but is no date: nothing is guessed from it.
  if (!Number.isFinite(daysLate)) return null;
  return { daysLate, tier: lateEntryTierForDaysLate(daysLate) };
}

/** Whether a note in this tier cannot be finalized without the author's own reason. */
export function tierNeedsReason(tier: LateEntryTier): boolean {
  return LATE_ENTRY_REASON_TIERS.includes(tier);
}

/** True when a write result is the server refusing a finalize for a missing or short late-entry reason. */
export function isLateEntryRefusal(result: WriteResult<unknown>): boolean {
  return !result.ok && result.code === LATE_ENTRY_REASON_REQUIRED_CODE;
}

export function reasonLength(reason: string): number {
  return reason.trim().length;
}

export function reasonIsLongEnough(reason: string): boolean {
  return reasonLength(reason) >= LATE_ENTRY_REASON_MIN_CHARS;
}

/**
 * What goes in the finalize body. A reason shorter than the minimum is not sent: the server would refuse the body itself (a schema
 * error in its own words) rather than judge the note, so a short one is left for the server's plain refusal, which the box then shows.
 */
export function reasonToSend(reason: string): string | undefined {
  return reasonIsLongEnough(reason) ? reason.trim() : undefined;
}

/** The counter under the box: how many characters are in, and how many are still missing. */
export function reasonCountText(reason: string): string {
  const length = reasonLength(reason);
  if (length >= LATE_ENTRY_REASON_MIN_CHARS) return `${length} characters`;
  return `${length} of ${LATE_ENTRY_REASON_MIN_CHARS} characters, ${LATE_ENTRY_REASON_MIN_CHARS - length} more needed`;
}

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;

/** How late the note is, in words ("The visit was on 2026-11-17, 7 days ago."); empty when the composer cannot tell. */
export function lateEntryHowLate(
  serviceDate: string | null | undefined,
  estimate: LateEntryEstimate | null,
): string {
  if (!estimate || estimate.daysLate < 1) return "";
  const day = serviceDate?.slice(0, 10);
  return `The visit was on ${day}, ${plural(estimate.daysLate, "day")} ago.`;
}

const TIER_NAME: Readonly<Partial<Record<LateEntryTier, string>>> = {
  late_entry: "a late entry",
  significant_late_entry: "a significant late entry",
  administrative_override: "an administrative late entry",
};

/** The tier in plain words, or "" when the composer has no estimate (the server's tier is not guessed). */
export function lateEntryTierName(estimate: LateEntryEstimate | null): string {
  return estimate ? (TIER_NAME[estimate.tier] ?? "") : "";
}

/** Why a reason is asked for: the one sentence every tier shares. */
export const LATE_ENTRY_WHY =
  "A note entered after the visit has to be identified as late, with the reason, so the record shows why it was not documented sooner (Medicare Program Integrity Manual, ch. 3, section 3.3.2.5). Your reason is sent when you finalize the note.";

/** What must happen after finalizing, for the tiers that need an approval before the note can be signed (Module 8 §2.5); "" for the others. */
export function lateEntryApprovalNote(estimate: LateEntryEstimate | null): string {
  if (estimate?.tier === "significant_late_entry") {
    return "A Clinical Supervisor must also approve this late entry before it can be signed.";
  }
  if (estimate?.tier === "administrative_override") {
    return "A Director must also approve this late entry before it can be signed.";
  }
  return "";
}

/** The line under "Required documentation is complete" while the late-entry reason is still outstanding, so that card is not the final word. */
export const LATE_ENTRY_READY_TEXT =
  "The sections are complete. Add the late-entry reason above, then finalize.";
