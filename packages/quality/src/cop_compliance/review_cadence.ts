// @wardenx/quality — M30 §7.7 / D10: the 6-month CoP review-cadence logic (WF-17).
//
// Every `cop_compliance_status` row carries a `last_reviewed_at` attestation and a `next_review_due_at`
// derived from it. CMS expects the Compliance Officer to re-attest each citation on a 6-month default
// cadence; when `now - last_reviewed_at > 180 days` the citation is OVERDUE and the
// `m30.alerts.cop_review_overdue` alert fires every 14 days until re-attested (the citation does NOT
// auto-transition out of `compliant` — only the attestation reset or a manual transition clears it).
//
// PURE DOMAIN (P2a): the cadence is a pure function of `(lastReviewedAt, now)`. No DB, no clock — the
// caller injects `now`. Invalid timestamps throw a `ChartWardenError`. The recompute/alert worker (a LATER
// phase) calls `computeNextReviewDueAt` to persist `next_review_due_at` on attestation, and
// `evaluateReviewCadence` to decide whether the overdue alert fires.
import { ChartWardenError } from "@wardenx/types";

/** The default CoP review cadence in days (6 months, WF-17). */
export const COP_REVIEW_CADENCE_DAYS = 180;

/** How many days before the due date the cadence reports `due_soon` (a non-blocking heads-up window). */
export const COP_REVIEW_DUE_SOON_DAYS = 14;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Where a citation sits in its review cycle relative to the injected `now`. */
export type CopReviewCadenceState = "current" | "due_soon" | "overdue";

/** The resolved cadence position for one citation (WF-17). */
export interface CopReviewCadence {
  /** `current` (>14d to due), `due_soon` (≤14d to due, not yet past), or `overdue` (past due). */
  readonly state: CopReviewCadenceState;
  /** ISO-8601 instant the next review is due (`lastReviewedAt + 180d`). */
  readonly dueAt: string;
  /** Whole days until the review is due — negative once overdue. */
  readonly daysUntilDue: number;
  /** Whole days past due — `0` until overdue, then the positive overdue age (drives the 14-day re-fire). */
  readonly daysOverdue: number;
}

/** Parse an ISO-8601 instant (or `Date`) to epoch-ms, throwing `ChartWardenError` on an invalid value. */
function toEpochMs(value: Date | string, field: string): number {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new ChartWardenError(
      "cop_review_invalid_timestamp",
      `${field} is not a valid ISO-8601 instant`,
      422,
    );
  }
  return ms;
}

/**
 * The `next_review_due_at` for a citation given its `last_reviewed_at` — the persisted value the
 * attestation handler writes (WF-17). Returns an ISO-8601 instant `lastReviewedAt + 180 days`.
 */
export function computeNextReviewDueAt(lastReviewedAt: Date | string): string {
  const reviewedMs = toEpochMs(lastReviewedAt, "lastReviewedAt");
  return new Date(reviewedMs + COP_REVIEW_CADENCE_DAYS * MS_PER_DAY).toISOString();
}

/**
 * Resolve where a citation sits in its 6-month review cycle as of `now` (WF-17). `now` is injected to
 * keep the function pure. A citation is `overdue` once `now - lastReviewedAt > 180 days`; `due_soon`
 * within the final 14 days before the due date; otherwise `current`.
 */
export function evaluateReviewCadence(
  lastReviewedAt: Date | string,
  now: Date | string,
): CopReviewCadence {
  const reviewedMs = toEpochMs(lastReviewedAt, "lastReviewedAt");
  const nowMs = toEpochMs(now, "now");
  const dueMs = reviewedMs + COP_REVIEW_CADENCE_DAYS * MS_PER_DAY;

  // Truncate toward zero so a partial day does not flip an exactly-on-boundary citation prematurely.
  const daysUntilDue = Math.trunc((dueMs - nowMs) / MS_PER_DAY);
  const daysOverdue = daysUntilDue < 0 ? -daysUntilDue : 0;

  let state: CopReviewCadenceState;
  if (nowMs > dueMs) {
    state = "overdue";
  } else if (daysUntilDue <= COP_REVIEW_DUE_SOON_DAYS) {
    state = "due_soon";
  } else {
    state = "current";
  }

  return {
    state,
    dueAt: new Date(dueMs).toISOString(),
    daysUntilDue,
    daysOverdue,
  };
}

/** Convenience predicate: is the citation's review past its 6-month due date as of `now` (WF-17)? */
export function isReviewOverdue(lastReviewedAt: Date | string, now: Date | string): boolean {
  return evaluateReviewCadence(lastReviewedAt, now).state === "overdue";
}
