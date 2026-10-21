// M36 ADR-0087 (PROPOSED), D5 - when a break-glass review is due and when an unanswered one escalates. Pure: the caller passes the clock.
// A review is due one BUSINESS day after the grant ends (Monday to Friday, UTC, the time of day kept) and escalates to compliance three
// CALENDAR days after it ends. Both numbers are named constants in @chartwarden/types and, until compliance confirms them, a default.
import {
  BREAK_GLASS_REVIEW_DUE_BUSINESS_DAYS,
  BREAK_GLASS_REVIEW_ESCALATE_DAYS,
} from "@chartwarden/types";

const DAY_MS = 86_400_000;
const SUNDAY = 0;
const SATURDAY = 6;

/** `from` plus `days` business days: each calendar day is stepped in turn and Saturday and Sunday are not counted. */
export function addBusinessDays(from: Date, days: number): Date {
  if (!Number.isSafeInteger(days) || days < 0) {
    throw new RangeError("days must be a whole number >= 0");
  }
  let remaining = days;
  let at = from.getTime();
  while (remaining > 0) {
    at += DAY_MS;
    const weekday = new Date(at).getUTCDay();
    if (weekday !== SATURDAY && weekday !== SUNDAY) remaining -= 1;
  }
  return new Date(at);
}

/** When the review of a grant that ended at `endedAt` is due. */
export function reviewDueAt(endedAt: Date): Date {
  return addBusinessDays(endedAt, BREAK_GLASS_REVIEW_DUE_BUSINESS_DAYS);
}

/** When an unanswered review of a grant that ended at `endedAt` raises the overdue alert. */
export function reviewEscalateAt(endedAt: Date): Date {
  return new Date(endedAt.getTime() + BREAK_GLASS_REVIEW_ESCALATE_DAYS * DAY_MS);
}

/** The end of a grant: the earlier of its expiry and its revocation (the planned expiry while it is still live). */
export function grantEndedAt(expiresAt: Date, revokedAt: Date | null): Date {
  return revokedAt && revokedAt.getTime() < expiresAt.getTime() ? revokedAt : expiresAt;
}

/** Pending and past its due instant. A completed review is never overdue. */
export function isReviewOverdue(
  review: { readonly completed: boolean; readonly endedAt: Date },
  now: Date,
): boolean {
  return !review.completed && now.getTime() > reviewDueAt(review.endedAt).getTime();
}
