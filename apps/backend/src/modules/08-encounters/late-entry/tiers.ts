// apps/backend/src/modules/08-encounters/late-entry/tiers.ts — M8-T07 (§2.5 D4).
//
// The §2.5 three-tier late-entry policy as a PURE clock. The clock starts at `service_date` end-of-day
// org-local (M6 D8 calendar-date convention) and the tier is read off how late the documentation is at
// finalize-time:
//   ≤ 24h        → normal                     (no extra requirement)
//   24h–72h      → late_entry                 (late_entry_reason ≥ 40 chars)
//   72h–14 days  → significant_late_entry      (reason + Clinical Supervisor override + step-up)
//   > 14 days    → administrative_override      (director perm + reason ≥ 100 + step-up + compliance outbox)
// Because both `service_date` and the finalize date are org-local LocalDates, the hour windows reduce
// exactly to whole-calendar-day deltas (24h = 1 day, 72h = 3 days, 14 days = 14): the boundary instant
// `service_date end-of-day + Nh` falls on the end-of-day of `service_date + (N/24) days`, so documenting
// any time on a given calendar day is measured by that day's delta. No IO, no `Date.now()` — `asOfDate`
// (the org-local finalize day) is injected, so the tiers are deterministic and unit-testable (§7.5/§7.6).
import type { LateEntryTier, LocalDate } from "@wardenx/types";
import { daysBetween } from "../lifecycle/validation";

/**
 * The §2.5 tier day-ceilings (inclusive upper bound, in whole calendar days late). A tier applies when
 * `daysLate` is ≤ its ceiling and > the previous tier's; `administrative_override` is everything beyond
 * the `significant_late_entry` ceiling (no upper bound).
 */
export const LATE_ENTRY_TIER_DAY_CEILINGS = {
  /** ≤ 24h since service_date end-of-day. */
  normal: 1,
  /** 24h–72h. */
  late_entry: 3,
  /** 72h–14 days. */
  significant_late_entry: 14,
} as const;

/**
 * Whole calendar days the documentation is late: from `serviceDate` (the day the visit actually occurred)
 * to `asOfDate` (the org-local finalize day). The §2.5 render banner ("documented N days after service")
 * uses this exact count. Never negative for a valid encounter — `service_date ≤ today` is a separate §2.7
 * guard (`SERVICE_DATE_IN_FUTURE`), so a negative value here only arises if that guard was skipped.
 */
export function daysLate(serviceDate: LocalDate, asOfDate: LocalDate): number {
  return daysBetween(serviceDate, asOfDate);
}

/**
 * Compute the §2.5 D4 late-entry tier reified on the encounter row at finalize-time. Pure: the org-local
 * finalize day is injected. A same-day or next-day entry (≤ 24h) is `normal`; the ceilings above bin the
 * rest. The service composes this with the {@link import("./override")} override gate at sign.
 */
export function computeLateEntryTier(input: {
  readonly serviceDate: LocalDate;
  readonly asOfDate: LocalDate;
}): LateEntryTier {
  const late = daysLate(input.serviceDate, input.asOfDate);
  if (late <= LATE_ENTRY_TIER_DAY_CEILINGS.normal) return "normal";
  if (late <= LATE_ENTRY_TIER_DAY_CEILINGS.late_entry) return "late_entry";
  if (late <= LATE_ENTRY_TIER_DAY_CEILINGS.significant_late_entry) return "significant_late_entry";
  return "administrative_override";
}

/**
 * The §2.5 render banner text M22 stamps on the PDF (carried in the `m8.encounter.signed` payload via the
 * reified `late_entry_tier` field). `normal`/`late_entry` carry no banner; the two override tiers name the
 * day-count. M22 owns the actual render — this helper keeps the wording in one pure place for tests.
 */
export function lateEntryBanner(tier: LateEntryTier, days: number): string | null {
  switch (tier) {
    case "significant_late_entry":
      return `Late entry — documented ${days} days after service`;
    case "administrative_override":
      return `Administrative late entry — ${days} days after service`;
    default:
      return null;
  }
}
