// @chartwarden/billing — M23 SIA (Service Intensity Add-on) calculator (D6, spec §1.1 / §3.3
// `sia_calculation`). A PURE function that walks the injected SIGNED encounters for the last 7 days of
// the patient's life (`[deceasedDate − 6, deceasedDate]`, inclusive) and produces the CMS SIA add-on:
// for RHC days, qualifying RN / MSW (social-work) in-person visit time in that window is paid at the CHC
// hourly rate, capped at 4 hours (240 minutes) per day, IN ADDITION TO the RHC per-diem. The add-on
// fires ONLY when the patient is deceased AND at least one qualifying signed visit landed in the window;
// a not-deceased patient, or a deceased patient with no qualifying visit, yields no SIA row (`present:
// false`) — the Phase-3 service then writes no `sia_calculation` row at all.
//
// The calculator is purely encounter-derived (D6) — it does NOT consult M9/M10/M14. The CHC hourly rate
// is the wage-index-ADJUSTED published CMS amount and is INJECTED by the caller (not fabricated here).
// The 4-hour/day cap is the documented CMS SIA rule. The CHC hourly amount per FY is TENANT-ENTERED (F-210,
// `hospice_rate_table.chc_hourly_rate_cents`), wage-adjusted at the service layer on the CHC LABOR SHARE only (F-211), and
// passed in as `chcHourlyRateCents`.
//
// PURE DOMAIN: no Fastify, no Drizzle/DB, no BullMQ, no `@chartwarden/db`, no `getSeam`, no clock. No PHI (D13).
import type { IsoDate } from "../contracts";
import { addDaysIso, isWithinInclusive } from "../domain/dates";
import type { Cents } from "../domain/money";
import { lineChargeCents, sumCents } from "../domain/money";

/** The default qualifying disciplines (CMS SIA rule): registered nurse + medical social worker. */
export const SIA_QUALIFYING_DISCIPLINES: readonly string[] = ["RN", "MSW"] as const;

/** The default per-day SIA cap: 4 hours = 240 minutes of qualifying visit time (CMS rule). */
export const SIA_MAX_MINUTES_PER_DAY = 240;

/** One injected signed encounter (M8 `SignedEncountersReader`) considered for the SIA window. */
export interface SiaEncounterInput {
  readonly encounterId: string;
  readonly serviceDate: IsoDate;
  /** Discipline code (e.g. `"RN"`, `"MSW"`, `"HHA"`, `"chaplain"`); matched case-insensitively. */
  readonly discipline: string;
  readonly durationMinutes: number;
  /** Only SIGNED visits qualify — an unsigned visit is excluded even if in-window and RN/MSW. */
  readonly signed: boolean;
}

/** The pure SIA calculator input — all plain data; nothing is read from a seam or clock. */
export interface SiaCalculationInput {
  /** The patient's date of death (M5 `patient.deceased_date`); `null` ⇒ not deceased ⇒ no SIA. */
  readonly deceasedDate: IsoDate | null;
  readonly signedEncounters: readonly SiaEncounterInput[];
  /** The wage-index-adjusted CHC HOURLY rate in whole cents (injected; TODO(CMS-fixture) per FY). */
  readonly chcHourlyRateCents: Cents;
  /** Per-day minute cap; defaults to {@link SIA_MAX_MINUTES_PER_DAY} (4 hours). */
  readonly maxMinutesPerDay?: number;
  /** Qualifying disciplines; defaults to {@link SIA_QUALIFYING_DISCIPLINES} (RN + MSW). */
  readonly qualifyingDisciplines?: readonly string[];
}

/** One qualifying visit captured in the result (mirrors `sia_calculation.qualifying_visits`). */
export interface SiaQualifyingVisitResult {
  readonly encounterId: string;
  readonly visitDate: IsoDate;
  readonly discipline: string;
  readonly durationMinutes: number;
}

/** The pure SIA calculation result — the caller persists this onto `sia_calculation` when `present`. */
export interface SiaCalculationResult {
  /** True iff the SIA applies (patient deceased AND ≥1 qualifying signed in-window visit). */
  readonly present: boolean;
  readonly patientDeceasedDate: IsoDate | null;
  /** `deceasedDate − 6` (inclusive window start); `null` when not deceased. */
  readonly windowStart: IsoDate | null;
  /** `deceasedDate` (inclusive window end); `null` when not deceased. */
  readonly windowEnd: IsoDate | null;
  readonly qualifyingVisits: readonly SiaQualifyingVisitResult[];
  /** Total qualifying minutes BEFORE the per-day cap (the raw clinical minutes in-window). */
  readonly totalQualifyingMinutes: number;
  /** Total minutes actually PAID after the per-day cap (the basis of `siaAddOnCents`). */
  readonly paidMinutes: number;
  readonly siaAddOnCents: Cents;
}

const EMPTY_RESULT: SiaCalculationResult = {
  present: false,
  patientDeceasedDate: null,
  windowStart: null,
  windowEnd: null,
  qualifyingVisits: [],
  totalQualifyingMinutes: 0,
  paidMinutes: 0,
  siaAddOnCents: 0,
};

/**
 * Compute the SIA add-on (D6). Returns the empty (`present: false`) result when the patient is not
 * deceased or no qualifying RN/MSW signed visit landed in the last-7-days-of-life window. Otherwise sums
 * qualifying visit minutes per day, caps each day at `maxMinutesPerDay`, and prices the capped minutes at
 * the injected CHC hourly rate (per-minute = hourly / 60, via the penny-exact `lineChargeCents`). Pure +
 * deterministic.
 */
export function calculateSia(input: SiaCalculationInput): SiaCalculationResult {
  if (input.deceasedDate === null) return EMPTY_RESULT;

  const windowEnd = input.deceasedDate;
  const windowStart = addDaysIso(windowEnd, -6);
  const cap = input.maxMinutesPerDay ?? SIA_MAX_MINUTES_PER_DAY;
  const disciplines = (input.qualifyingDisciplines ?? SIA_QUALIFYING_DISCIPLINES).map((d) =>
    d.toUpperCase(),
  );

  // 1. Filter to signed, qualifying-discipline, in-window, positive-duration visits.
  const qualifying = input.signedEncounters.filter(
    (e) =>
      e.signed &&
      e.durationMinutes > 0 &&
      disciplines.includes(e.discipline.toUpperCase()) &&
      isWithinInclusive(e.serviceDate, windowStart, windowEnd),
  );

  if (qualifying.length === 0) {
    return {
      ...EMPTY_RESULT,
      patientDeceasedDate: windowEnd,
      windowStart,
      windowEnd,
    };
  }

  // 2. Aggregate minutes per service-date, then apply the per-day cap.
  const minutesByDate = new Map<IsoDate, number>();
  for (const e of qualifying) {
    minutesByDate.set(e.serviceDate, (minutesByDate.get(e.serviceDate) ?? 0) + e.durationMinutes);
  }

  let paidMinutes = 0;
  const perDayChargeCents: Cents[] = [];
  for (const rawMinutes of minutesByDate.values()) {
    const capped = Math.min(rawMinutes, cap);
    paidMinutes += capped;
    // CHC hourly rate priced per-minute: hours = capped / 60, charge = round(hourly × hours).
    perDayChargeCents.push(lineChargeCents(capped / 60, input.chcHourlyRateCents));
  }

  const qualifyingVisits: SiaQualifyingVisitResult[] = qualifying.map((e) => ({
    encounterId: e.encounterId,
    visitDate: e.serviceDate,
    discipline: e.discipline,
    durationMinutes: e.durationMinutes,
  }));

  return {
    present: true,
    patientDeceasedDate: windowEnd,
    windowStart,
    windowEnd,
    qualifyingVisits,
    totalQualifyingMinutes: qualifying.reduce((sum, e) => sum + e.durationMinutes, 0),
    paidMinutes,
    siaAddOnCents: sumCents(perDayChargeCents),
  };
}
