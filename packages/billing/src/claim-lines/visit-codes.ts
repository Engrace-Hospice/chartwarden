// @chartwarden/billing — the hospice visit-line code table (CMS Pub. 100-04 ch. 11 §30.3, "Revenue Codes" table;
// MAC billing sheets, e.g. CGS "Hospice Medicare Billing Codes Sheet"). Every visit by hospice staff is its own
// dated claim line, reported in 15-minute increments under a discipline revenue code with a G-code. Charges on
// these lines are bundled into the level-of-care payment (no additional payment); the MAC reads the RN
// (G0299) and social-work (G0155) lines to price the end-of-life Service Intensity Add-on.
// PURE: no I/O, no clock.
import type { VisitChargeDiscipline } from "../visit-charges";

/** Hospice visits are reported in multiples of this many minutes (ch. 11 §30.3 "Service Units"). */
export const HOSPICE_VISIT_UNIT_MINUTES = 15;

/** The visit revenue codes this module can emit. */
export type VisitRevenueCode = "0421" | "0431" | "0441" | "0551" | "0561" | "0569" | "0571";

export interface VisitCode {
  readonly revenueCode: VisitRevenueCode;
  readonly hcpcsCode: string;
  /** What the visit charge is keyed by (an aide is `chha`; a social-work call is `msw`). */
  readonly discipline: VisitChargeDiscipline;
}

/** Every visit revenue code, as a runtime list (DB enum / contract lockstep checks read it). */
export const VISIT_REVENUE_CODES: readonly VisitRevenueCode[] = [
  "0421",
  "0431",
  "0441",
  "0551",
  "0561",
  "0569",
  "0571",
] as const;

/** True for a discipline visit revenue code (042x-057x as emitted here), false for a level-of-care / other code. */
export function isVisitRevenueCode(revenueCode: string): boolean {
  return (VISIT_REVENUE_CODES as readonly string[]).includes(revenueCode);
}

const PHYSICAL_THERAPY: VisitCode = { revenueCode: "0421", hcpcsCode: "G0151", discipline: "pt" };
const OCCUPATIONAL_THERAPY: VisitCode = {
  revenueCode: "0431",
  hcpcsCode: "G0152",
  discipline: "ot",
};
const SPEECH_LANGUAGE_PATHOLOGY: VisitCode = {
  revenueCode: "0441",
  hcpcsCode: "G0153",
  discipline: "slp",
};
/** G0299 — direct skilled nursing by a registered nurse (valid from 2016-01-01; G0154 is retired). */
const SKILLED_NURSING_RN: VisitCode = { revenueCode: "0551", hcpcsCode: "G0299", discipline: "rn" };
/** G0300 — direct skilled nursing by a licensed practical nurse. */
const SKILLED_NURSING_LPN: VisitCode = {
  revenueCode: "0551",
  hcpcsCode: "G0300",
  discipline: "lpn",
};
const SOCIAL_WORK_VISIT: VisitCode = { revenueCode: "0561", hcpcsCode: "G0155", discipline: "msw" };
/** A medical social worker phone call (a separate line item per call). */
const SOCIAL_WORK_PHONE_CALL: VisitCode = {
  revenueCode: "0569",
  hcpcsCode: "G0155",
  discipline: "msw",
};
const HOSPICE_AIDE: VisitCode = { revenueCode: "0571", hcpcsCode: "G0156", discipline: "chha" };

/**
 * Encounter types that never produce a visit line: IDG time, bereavement and volunteer/chaplain contacts are not
 * the billable disciplines (ch. 11 §30.3: IDG time, documentation and travel are not visit time).
 */
const NON_VISIT_ENCOUNTER_TYPES: ReadonlySet<string> = new Set([
  "idg_followup",
  "bereavement_contact",
  "volunteer_visit",
  "chaplain_assessment",
  "chaplain_visit",
]);

export interface VisitCodeInput {
  /** The authoring discipline (`rn`, `lpn`, `chha`, `msw`, and — where an encounter model carries them — `pt`/`ot`/`slp`). */
  readonly discipline: string;
  readonly encounterType?: string | null;
}

/**
 * The revenue code + HCPCS a visit is reported under, or `null` when the encounter is not a reportable visit.
 * Physician and nurse-practitioner services (`md`/`np`) are NOT visit lines — they ride revenue code 0657 with a
 * CPT/HCPCS from the MAC — and chaplain/volunteer care is never reported on the claim.
 */
export function visitCodeFor(input: VisitCodeInput): VisitCode | null {
  const encounterType = input.encounterType ?? null;
  if (encounterType !== null && NON_VISIT_ENCOUNTER_TYPES.has(encounterType)) return null;
  const telephonic = encounterType === "telephonic";
  switch (input.discipline.toLowerCase()) {
    case "rn":
      return telephonic ? null : SKILLED_NURSING_RN;
    case "lpn":
      return telephonic ? null : SKILLED_NURSING_LPN;
    case "chha":
      return telephonic ? null : HOSPICE_AIDE;
    case "msw":
      return telephonic ? SOCIAL_WORK_PHONE_CALL : SOCIAL_WORK_VISIT;
    case "pt":
      return telephonic ? null : PHYSICAL_THERAPY;
    case "ot":
      return telephonic ? null : OCCUPATIONAL_THERAPY;
    case "slp":
      return telephonic ? null : SPEECH_LANGUAGE_PATHOLOGY;
    default:
      return null;
  }
}

/**
 * Units for a visit of `minutes`: the nearest 15-minute increment, never below 1 — "visits of any length are to
 * be reported, rounding the time to the nearest 15-minute increment" (ch. 11 §30.3). `null` when the duration is
 * not a positive finite number: a documentation gap is never fabricated into a duration.
 */
export function visitUnitsForMinutes(minutes: number): number | null {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.max(1, Math.round(minutes / HOSPICE_VISIT_UNIT_MINUTES));
}
