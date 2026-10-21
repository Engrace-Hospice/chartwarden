// @chartwarden/inpatient — M37-T10, §2.13 D14. The hospice service-day rule for the daily census. A service
// day counts for an admission when the admission was active for ANY portion of the service date (the
// standard hospice bed-day convention). Pure & IO-free — the census-snapshot-builder cron injects the
// admission's active window + the service date's [start, end) in ms.

/**
 * §2.13 — did an admission active-window overlap any portion of the service date? `activeEndMs === null`
 * means still active (open-ended). The service date is the half-open interval `[serviceDateStartMs,
 * serviceDateEndMs)` (tenant-local midnight to next midnight, resolved upstream).
 */
export function isServiceDay(
  activeStartMs: number,
  activeEndMs: number | null,
  serviceDateStartMs: number,
  serviceDateEndMs: number,
): boolean {
  const end = activeEndMs ?? Number.POSITIVE_INFINITY;
  // Overlap of [activeStart, end) with [dayStart, dayEnd): start < dayEnd AND end > dayStart.
  return activeStartMs < serviceDateEndMs && end > serviceDateStartMs;
}
