// M25 — Medicare appeal-tier deadline computation (D6, M25-F04, §1.3). PURE.
//
// The regulatory clock, single-sourced (M25-F04 corrects the original spec's `created_at + 120`):
//   - redetermination  : remittance_received_at + 120 days   (42 CFR §405.942(a))
//   - reconsideration  : prior-tier decision date + 180 days  (42 CFR §405.962)
//   - alj              : prior-tier decision date + 60 days   (42 CFR §405.1002)
//   - council          : prior-tier decision date + 60 days   (42 CFR §405.1102)
//   - federal_court    : prior-tier decision date + 60 days   (42 CFR §405.1136)
//
// The anchor differs by tier: redetermination anchors on the REMITTANCE-received date; every later tier
// anchors on the PRIOR tier's decision-letter date. The `appeal.submit` route hard-blocks past T-0 via the
// `appeal_within_deadline` ABAC predicate; the deadline cron emits T-30/T-14/T-7/T-1 alerts.
import type { AppealTier } from "./types";

/** Filing windows (days) per tier from its anchor. */
export const TIER_WINDOW_DAYS: Record<AppealTier, number> = {
  redetermination: 120,
  reconsideration: 180,
  alj: 60,
  council: 60,
  federal_court: 60,
};

/** The deadline-alert boundaries the cron fires at (days remaining), plus the hard T-0 block. */
export const DEADLINE_ALERT_DAYS: readonly number[] = [30, 14, 7, 1];

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

/**
 * Compute a tier's filing deadline.
 * - For `redetermination`, pass the remittance-received date as `anchor`.
 * - For every later tier, pass the prior-tier decision-letter date as `anchor`.
 */
export function computeTierDeadline(tier: AppealTier, anchor: Date): Date {
  return addDays(anchor, TIER_WINDOW_DAYS[tier]);
}

/** The tier that follows `tier` in the Medicare hierarchy, or null at the terminal (federal_court). */
export function nextTier(tier: AppealTier): AppealTier | null {
  const order: AppealTier[] = ["redetermination", "reconsideration", "alj", "council", "federal_court"];
  const i = order.indexOf(tier);
  return i >= 0 && i < order.length - 1 ? order[i + 1]! : null;
}

/** Whole days remaining until the deadline (may be negative once past). */
export function daysUntilDeadline(deadlineAt: Date, now: Date): number {
  return Math.ceil((deadlineAt.getTime() - now.getTime()) / 86_400_000);
}

/** Fail-closed deadline gate — the truth behind the `appeal_within_deadline` ABAC predicate (D6/D7). */
export function isWithinDeadline(deadlineAt: Date, now: Date): boolean {
  return now.getTime() <= deadlineAt.getTime();
}

/**
 * Which alert boundary (if any) `now` has just crossed for a deadline — used by the deadline cron to emit
 * one M36 alert per boundary. Returns the largest threshold whose window the remaining days fall within,
 * or null when more than 30 days remain (and 0 is represented by the hard T-0 block, not an alert here).
 */
export function deadlineAlertBoundary(deadlineAt: Date, now: Date): number | null {
  const remaining = daysUntilDeadline(deadlineAt, now);
  if (remaining < 0) return null;
  // The active boundary is the TIGHTEST threshold the remaining days still fall within (e.g. 7 days
  // remaining → T-7, not T-30). Iterate ascending and return the first threshold >= remaining.
  const ascending = [...DEADLINE_ALERT_DAYS].sort((a, b) => a - b);
  for (const t of ascending) {
    if (remaining <= t) return t;
  }
  return null;
}
