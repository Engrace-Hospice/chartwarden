// @wardenx/shared — org-local-date (PARAM-004 follow-up). Server-side "what is today for this
// tenant" — the backend analogue of packages/ui/src/core/dates.ts's frontend fix. Several
// call sites computed "today" by slicing a UTC instant's ISO string
// (`new Date().toISOString().slice(0, 10)`), which reads the WRONG calendar day for a large
// fraction of every US business day: UTC is ahead of every US timezone, so for roughly the last
// 4-8 hours of a US business day, UTC has already rolled over to the next date while it is still
// "today" locally. This is org-scoped, not server-scoped, because a hospice organization's actual
// operating timezone (the org_timezone setting, packages/db/src/organization-settings) is the
// authority for its own service dates/eligibility windows — never the server process's timezone,
// which says nothing about where the org operates. Zero dependencies — `Intl.DateTimeFormat` is a
// JS/ICU built-in.

/**
 * The calendar date (`YYYY-MM-DD`) `instant` falls on when read in IANA zone `timeZone`. Throws
 * `RangeError` for a `timeZone` `Intl` does not recognize — callers should treat that as "the
 * stored org_timezone value is corrupt", fail closed to `DEFAULT_ORGANIZATION_TIMEZONE`
 * (packages/db/src/organization-settings), and log it; a corrupt timezone must never silently
 * fall back to naive UTC slicing, which is the exact bug this function exists to fix.
 */
export function localDateInTimeZone(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD — the one common locale whose default date format IS ISO order,
  // so no manual part-reassembly (year/month/day parts individually) is needed.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

/** `localDateInTimeZone(new Date(), timeZone)` — "today" in an org's operating timezone, now. */
export function orgLocalDateToday(timeZone: string): string {
  return localDateInTimeZone(new Date(), timeZone);
}

/** True iff `Intl` recognizes `timeZone` as a real IANA zone (or `UTC`). */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
}
