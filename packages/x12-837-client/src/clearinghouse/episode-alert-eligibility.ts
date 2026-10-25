// @chartwarden/x12-837-client — Episode Alert eligibility response -> the port's outcome (#758, ADR-0053).
//
// Episode Alert translates the CMS HETS 271 into XML and documents the report sections publicly
// (https://episodealert.com/medicare-eligibility.aspx): "Part A & B" carries Part A/B eligibility start and end dates.
// The XML schema itself is given only after signup, so the element names below are UNVERIFIED guesses from the sample
// report's labels. They are the ONE place to correct once a trial account returns a real response; the matching
// fixtures live in episode-alert.test.ts. Anything unrecognised yields "unknown", never "active".
import type { EligibilityOutcome } from "../types";

/** UNVERIFIED element names (local names; any namespace prefix is accepted). First match wins. */
export const EPISODE_ALERT_ELIGIBILITY_FIELDS = {
  partAStart: ["PartAEligibilityStartDate", "PartAStartDate", "PartAEffectiveDate"],
  partAEnd: ["PartAEligibilityEndDate", "PartAEndDate", "PartATerminationDate"],
} as const;

const MAX_XML_CHARS = 1_000_000;

type Element = { kind: "absent" } | { kind: "unreadable" } | { kind: "value"; value: string };

/**
 * Reads exactly one element from any of `localNames`. Absent means no such tag; anything that is not one plain text
 * value (a repeat, an empty or self-closing tag, nested children, a value over 32 chars) is unreadable, never absent,
 * so a changed response cannot read as "no end date".
 */
function readElement(xml: string, localNames: readonly string[]): Element {
  const open = new RegExp(`<(?:[A-Za-z0-9_]+:)?(?:${localNames.join("|")})(?=[\\s>/])[^>]*>`, "gi");
  const tags = [...xml.matchAll(open)];
  if (tags.length === 0) return { kind: "absent" };
  const tag = tags[0];
  if (tags.length > 1 || !tag || tag[0].endsWith("/>")) return { kind: "unreadable" };
  const text = /^\s*([^<]{1,32}?)\s*</.exec(xml.slice((tag.index ?? 0) + tag[0].length));
  return text?.[1] ? { kind: "value", value: text[1] } : { kind: "unreadable" };
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
  // Comments, CDATA and DTDs can hide or fake elements; this reader does not parse them, so it does not guess.
  if (xml.length > MAX_XML_CHARS || /<!--|<!\[CDATA\[|<!DOCTYPE|<!ENTITY/i.test(xml)) {
    return "unknown";
  }
  const day = toIsoDate(serviceDate);
  const rawStart = readElement(xml, EPISODE_ALERT_ELIGIBILITY_FIELDS.partAStart);
  const rawEnd = readElement(xml, EPISODE_ALERT_ELIGIBILITY_FIELDS.partAEnd);
  if (day === null || rawStart.kind !== "value" || rawEnd.kind === "unreadable") return "unknown";
  const start = toIsoDate(rawStart.value);
  const end = rawEnd.kind === "value" ? toIsoDate(rawEnd.value) : null;
  if (start === null || (rawEnd.kind === "value" && end === null)) return "unknown";
  if (start > day) return "inactive";
  if (end !== null && end < day) return "inactive";
  return "active";
}
