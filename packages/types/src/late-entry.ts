// packages/types/src/late-entry.ts — the §2.5 (Module 8, D4) late-entry rule as data and pure arithmetic: the one place the server
// and the visit-note composer both read it from, so a form can ask for the reason before a round trip without a second copy of the
// thresholds to drift. The SERVER stays the authority: it measures against the organization's local calendar day and reifies the tier.
//
// Why a late entry carries a reason: Medicare requires a delayed entry to be identified as such, dated and attributed (CMS Medicare
// Program Integrity Manual, Pub. 100-08, ch. 3, §3.3.2.5, "Amendments, Corrections and Delayed Entries in Medical Documentation":
// clearly and permanently identify a delayed entry as such, with its date and author, keeping the original content). The repo spec
// (Module 8 §2.5) turns that into tiers; the reason is the clinician's own account of the delay.
import type { LocalDate } from "./admission";
import type { LateEntryTier } from "./encounter";

/** The shortest `late_entry_reason` the server accepts (§2.5, also a DB CHECK on `encounter`). */
export const LATE_ENTRY_REASON_MIN_CHARS = 40;

/** The longest `late_entry_reason` the finalize / sign bodies accept (the free-text cap every M8 reason field shares). */
export const LATE_ENTRY_REASON_MAX_CHARS = 4000;

/**
 * The §2.5 tier day-ceilings (inclusive upper bound, in whole calendar days after `service_date`). A tier applies when the days late are
 * at most its ceiling and more than the previous tier's; `administrative_override` is everything beyond the last ceiling.
 */
export const LATE_ENTRY_TIER_DAY_CEILINGS = {
  /** 24h since the end of service_date. */
  normal: 1,
  /** 24h-72h. */
  late_entry: 3,
  /** 72h-14 days. */
  significant_late_entry: 14,
} as const;

/** The tiers whose finalize needs the author's own reason (every tier past `normal`). */
export const LATE_ENTRY_REASON_TIERS: ReadonlyArray<LateEntryTier> = [
  "late_entry",
  "significant_late_entry",
  "administrative_override",
];

/** Whole calendar days from `from` to `to` (to - from); negative when `to` precedes `from`. Both are `YYYY-MM-DD` calendar dates. */
export function calendarDaysBetween(from: LocalDate, to: LocalDate): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** The §2.5 tier for a note documented `daysLate` whole calendar days after the visit. */
export function lateEntryTierForDaysLate(daysLate: number): LateEntryTier {
  if (daysLate <= LATE_ENTRY_TIER_DAY_CEILINGS.normal) return "normal";
  if (daysLate <= LATE_ENTRY_TIER_DAY_CEILINGS.late_entry) return "late_entry";
  if (daysLate <= LATE_ENTRY_TIER_DAY_CEILINGS.significant_late_entry) {
    return "significant_late_entry";
  }
  return "administrative_override";
}
