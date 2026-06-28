// M25 — denial-case aging bucketing (§1.1, §2.3). PURE. The nightly `denial-aging` cron recomputes
// `aging_bucket_days` (whole days since opened_at) and the worklist read derives the bucket label from it.
import type { AgingBucketLabel } from "./types";

/** Whole days elapsed between two instants (floor; never negative). */
export function agingDays(openedAt: Date, now: Date): number {
  const ms = now.getTime() - openedAt.getTime();
  if (ms <= 0) return 0;
  return Math.floor(ms / 86_400_000);
}

/** Map an age-in-days to its worklist bucket label (0-7, 8-15, 16-30, 31-60, 61-90, 91+). */
export function agingBucketLabel(days: number): AgingBucketLabel {
  if (days <= 7) return "0-7";
  if (days <= 15) return "8-15";
  if (days <= 30) return "16-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "91+";
}

/** True once a denial has aged past the 30-day operational alert threshold (§2.4). */
export function crossedAgingAlertThreshold(days: number): boolean {
  return days > 30;
}

/** True once a denial has aged past 90 days with no appeal — triggers the high-severity escalation (§2.4). */
export function crossedStaleAppealThreshold(days: number): boolean {
  return days > 90;
}
