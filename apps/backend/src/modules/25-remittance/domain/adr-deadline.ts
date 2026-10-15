// M25 — ADR response deadline (milestone 2). PURE. The response is due `windowDays` calendar days after the
// request date the MAC's rule anchors on. A due day on a weekend or US federal holiday moves BACK to the
// previous business day (the same conservative rule as appeal deadlines, SME-approved 2026-10-15), and the
// due day is usable until its end in the provider zone (the earliest-ending one when a provider spans
// several). Window lengths vary by MAC and change, so they are DATA (an organization's `mac_rule` rows); the
// platform defaults below are consultant/MAC-web sourced and are always reported as UNVERIFIED.
import {
  DEFAULT_DEADLINE_ZONE,
  MS_PER_DAY,
  endOfDayInZone,
  isoDay,
  parseNoticeDay,
  previousBusinessDay,
} from "./deadline";
import type { AdrReviewType } from "./types";

/** Platform fallback windows (calendar days). CGS: 45 from the request date, re-ADR 20. Unverified. */
export const DEFAULT_ADR_WINDOWS: Readonly<Record<AdrReviewType, number>> = {
  adr: 45,
  re_adr: 20,
};

export interface AdrDeadlineDerivation {
  readonly requestedOn: string;
  readonly windowDays: number;
  readonly calendarDueDay: string; // requestedOn + windowDays, before any business-day roll-back
  readonly dueDay: string; // calendarDueDay, moved back to a business day
  readonly dueAt: Date; // end of dueDay in `zone`
  readonly zone: string;
}

export function deriveAdrDeadline(
  requestedOn: string,
  windowDays: number,
  zones: string | readonly string[] = DEFAULT_DEADLINE_ZONE,
): AdrDeadlineDerivation {
  if (!Number.isInteger(windowDays) || windowDays < 1) {
    throw new RangeError(`ADR window must be a whole number of days >= 1, got ${windowDays}`);
  }
  const calendarMs = parseNoticeDay(requestedOn) + windowDays * MS_PER_DAY;
  const dueMs = previousBusinessDay(calendarMs);
  const zoneList = Array.isArray(zones) ? zones : [zones as string];
  const ends = (zoneList.length > 0 ? zoneList : [DEFAULT_DEADLINE_ZONE]).map((zone) => ({
    zone,
    at: endOfDayInZone(dueMs, zone),
  }));
  const first = ends.reduce((a, b) => (b.at.getTime() < a.at.getTime() ? b : a));
  return {
    requestedOn,
    windowDays,
    calendarDueDay: isoDay(calendarMs),
    dueDay: isoDay(dueMs),
    dueAt: first.at,
    zone: first.zone,
  };
}

export interface AdrRuleRow {
  readonly macName: string;
  readonly reviewType: string;
  readonly responseDays: number;
  readonly verifiedOn: string | null;
  readonly sourceNote: string | null;
}

export interface AdrWindow {
  readonly days: number;
  readonly source: "org_rule" | "platform_default";
  readonly verified: boolean;
  readonly sourceNote: string | null;
}

/** The window for a MAC and review type: the organization's rule when it has one, else the platform default. */
export function resolveAdrWindow(
  rules: readonly AdrRuleRow[],
  macName: string,
  reviewType: AdrReviewType,
): AdrWindow {
  const wanted = macName.trim().toLowerCase();
  const rule = rules.find(
    (r) => r.macName.trim().toLowerCase() === wanted && r.reviewType === reviewType,
  );
  if (rule) {
    return {
      days: rule.responseDays,
      source: "org_rule",
      verified: rule.verifiedOn !== null,
      sourceNote: rule.sourceNote,
    };
  }
  return {
    days: DEFAULT_ADR_WINDOWS[reviewType],
    source: "platform_default",
    verified: false,
    sourceNote: null,
  };
}
