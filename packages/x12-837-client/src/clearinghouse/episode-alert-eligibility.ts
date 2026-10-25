// @chartwarden/x12-837-client — Episode Alert eligibility response -> the port's outcome (#758, ADR-0053).
//
// Episode Alert translates the CMS HETS 271 into XML and documents the report sections publicly
// (https://episodealert.com/medicare-eligibility.aspx): "Part A & B" carries Part A/B eligibility start and end dates.
// The XML schema itself is given only after signup, so the element names below are UNVERIFIED guesses from the sample
// report's labels. They are the ONE place to correct once a trial account returns a real response; the matching
// fixtures live in episode-alert-eligibility.test.ts. Anything unrecognised yields "unknown", never "active".
import type { EligibilityOutcome } from "../types";

/** UNVERIFIED element names (local names; any namespace prefix is accepted). First match wins. */
export const EPISODE_ALERT_ELIGIBILITY_FIELDS = {
  partAStart: ["PartAEligibilityStartDate", "PartAStartDate", "PartAEffectiveDate"],
  partAEnd: ["PartAEligibilityEndDate", "PartAEndDate", "PartATerminationDate"],
} as const;

const MAX_XML_CHARS = 1_000_000;

function tagValue(xml: string, localNames: readonly string[]): string | null {
  for (const name of localNames) {
    const m = new RegExp(`<(?:[A-Za-z0-9_]+:)?${name}[^>]*>\\s*([^<]{0,32}?)\\s*</`, "i").exec(xml);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** `20260101`, `2026-01-01` or `01/01/2026` -> `2026-01-01`; null for anything else or an impossible date. */
export function toIsoDate(raw: string): string | null {
  const compact = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(raw);
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  const [y, mo, d] = compact
    ? [compact[1], compact[2], compact[3]]
    : us
      ? [us[3], us[1], us[2]]
      : [];
  if (!y || !mo || !d) return null;
  const iso = `${y}-${mo}-${d}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso ? null : iso;
}

/**
 * Part A active on `serviceDate` (ISO) when it started on or before it and has not ended before it. Started later,
 * or ended earlier, is inactive. A missing or unreadable start date is unknown, so a changed schema fails safe.
 */
export function eligibilityOutcomeFromXml(xml: string, serviceDate: string): EligibilityOutcome {
  if (xml.length > MAX_XML_CHARS) return "unknown";
  const rawStart = tagValue(xml, EPISODE_ALERT_ELIGIBILITY_FIELDS.partAStart);
  const start = rawStart === null ? null : toIsoDate(rawStart);
  if (start === null) return "unknown";
  const rawEnd = tagValue(xml, EPISODE_ALERT_ELIGIBILITY_FIELDS.partAEnd);
  const end = rawEnd === null ? null : toIsoDate(rawEnd);
  if (rawEnd !== null && end === null) return "unknown";
  if (start > serviceDate) return "inactive";
  if (end !== null && end < serviceDate) return "inactive";
  return "active";
}
