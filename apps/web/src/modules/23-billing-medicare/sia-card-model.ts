// apps/web/src/modules/23-billing-medicare — the SIA card's data shape and wording (pure; no React). `SiaPricing` is the claim
// detail's `pricing.sia` (the server's `SiaView`, packages/billing/src/schemas/claim-read.ts): the claim's newest SIA revision.
// Medicare pays the add-on in 15-minute UNITS (<= 16 per day, RN + social work, in person, routine home care days, last 7 days
// of life) at the wage-adjusted CHC hourly rate / 4, so the card shows units, not minutes, and says in plain words why a visit
// did not count.
import { dollars } from "./billing-status";

export interface SiaVisit {
  id: string;
  date: string;
  discipline: string;
  minutes: number | null;
  /** Who supplied `minutes`: the EVV check-in/out or the clinician (typed); null = none / unknown (an older revision). */
  timeSource: "evv" | "clinician" | null;
  /** 15-minute units the visit is worth before the daily cap; null when it is not an eligible visit. */
  units: number | null;
  paidUnits: number;
  counted: boolean;
  /** The engine's exclusion code (null when counted). */
  reason: string | null;
}

export interface SiaPricing {
  basis: "minutes_v1" | "units_v2";
  revision: number;
  windowStart: string;
  windowEnd: string;
  paidUnits: number | null;
  eligibleUnits: number | null;
  truncatedUnits: number | null;
  chcHourlyRateCents: number | null;
  wageIndexFiscalYear: number | null;
  amountCents: number;
  totalQualifyingMinutes: number;
  calculatedAt: string;
  policy: {
    unitTieBreak: string;
    videoEligible: boolean;
    visitDating: string;
    wageBasis: string;
  } | null;
  visits: SiaVisit[];
  /** `cents` is null when the death year's CHC rate was unavailable (the units are known, their value is not). */
  priorClaimAdvisory: { from: string; to: string; units: number; cents: number | null } | null;
}

export const SIA_MAX_UNITS_PER_DAY = 16;

/** Plain-language wording per engine exclusion code (`SiaExclusionReason`). Keep in step with sia-units.ts. */
const REASON_TEXT: Readonly<Record<string, string>> = {
  outside_claim_window: "Outside this claim's service dates",
  ineligible_discipline: "Only RN and social work visits count",
  awaiting_cosignature: "Waiting for a co-signature",
  not_billable: "Visit is not billable",
  modality_telephonic: "Phone visit",
  non_visit_encounter: "Not an in-person patient visit",
  post_mortem: "Visit after the patient died",
  pm_modifier: "Billed with the post-mortem (PM) modifier",
  modality_unconfirmed: "Visit delivery mode not confirmed by the clinician",
  modality_video: "Video visit (not counted under the current policy)",
  no_documented_time: "No documented start/stop time",
  non_rhc_day: "Not a routine home care day",
  over_daily_cap: `Over the ${SIA_MAX_UNITS_PER_DAY}-unit daily cap`,
};

const UNKNOWN_REASON_TEXT = "Not counted for another reason";

export function siaReasonText(reason: string | null): string {
  return (reason !== null ? REASON_TEXT[reason] : undefined) ?? UNKNOWN_REASON_TEXT;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `5 units × $48.00 per hour ÷ 4 = $60.00` */
export function siaEquation(
  paidUnits: number,
  chcHourlyRateCents: number,
  amountCents: number,
): string {
  return `${plural(paidUnits, "unit")} × ${dollars(chcHourlyRateCents)} per hour ÷ 4 = ${dollars(amountCents)}`;
}

/** `5 units paid of 6 eligible; 1 unit over the 16-unit daily cap.` */
export function siaUnitsSummary(paid: number, eligible: number, truncated: number): string {
  const base = `${plural(paid, "unit")} paid of ${eligible} eligible`;
  return truncated > 0
    ? `${base}; ${plural(truncated, "unit")} over the ${SIA_MAX_UNITS_PER_DAY}-unit daily cap.`
    : `${base}.`;
}

/**
 * A visit's minutes as shown: whole minutes as they are, a fractional value (an EVV bracket is kept in seconds) to one
 * decimal, TRUNCATED, never rounded up. A label only: the figure itself is never rounded or adjusted. Every 15-minute
 * unit boundary (7.5, 22.5, 37.5, ...) is an exact tenth, so truncating can never show a visit as having reached a
 * boundary it has not (22 min 28 s reads "22.4", not "22.5", which would read like the 2-unit visit next to it).
 */
export function minutesLabel(minutes: number): string {
  if (Number.isInteger(minutes)) return String(minutes);
  // The epsilon absorbs binary float error on exact tenths (12.3 * 10 = 122.99999999999999); a second is 0.0167 minutes,
  // so 1e-7 can never carry a real fractional value across a tenth.
  return (Math.floor(minutes * 10 + 1e-7) / 10).toFixed(1);
}

/**
 * The Minutes cell: the documented minutes, plus where they came from. Typed minutes are marked so a reviewer can see which
 * units rest on times a clinician entered rather than an EVV check-in/out (an older revision records no source: unmarked).
 */
export function minutesCellText(visit: SiaVisit): string {
  if (visit.minutes === null) return "—";
  const source =
    visit.timeSource === "clinician" ? " (typed)" : visit.timeSource === "evv" ? " (EVV)" : "";
  return `${minutesLabel(visit.minutes)}${source}`;
}

/** The secondary line of a counted visit: only when the daily cap paid less than the visit was worth. */
export function siaPaidNote(visit: SiaVisit): string | null {
  if (!visit.counted || visit.units === null || visit.units === visit.paidUnits) return null;
  return `${visit.paidUnits} of ${visit.units} units paid (daily cap)`;
}
