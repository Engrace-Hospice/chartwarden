// @chartwarden/billing — the shared SIA units engine (M23, D6). Medicare pays the Service Intensity Add-on from the
// claim's visit lines (Medicare Claims Processing Manual ch. 11 §30.2.2; 42 CFR 418.302(e)(4); 80 FR 47142): in-person
// RN (0551 + G0299) and social-work (056x + G0155) care on ROUTINE HOME CARE days in the last 7 days of life
// (`[death − 6, death]`, the death date is day 1 of 7), each visit rounded to 15-minute units, 1..16 units per day
// combined, paid at the wage-adjusted CHC hourly rate / 4 per unit. ONE pure function owns that decision so the
// forecast, the claim snapshot, the validation rule and the visit lines cannot drift apart. Every visit in the window
// comes back with a counted/excluded verdict and a reason, so billing sees WHY an hour of care is not payable.
// Documented time is never fabricated: a visit with no start/stop is reported `no_documented_time`, never defaulted.
// PURE: no I/O, no clock, no PHI (D13).
import {
  DEFAULT_UNIT_TIE_BREAK,
  type UnitTieBreak,
  type VisitModality,
  isSiaVisitCode,
  visitCodeFor,
  visitUnitsForMinutes,
} from "../claim-lines/visit-codes";
import type { IsoDate, LevelOfCare } from "../contracts";
import { addDaysIso, isWithinInclusive, maxIso, minIso } from "../domain/dates";
import { normalizeDiscipline } from "../domain/discipline";
import type { Cents } from "../domain/money";
import { lineChargeCents } from "../domain/money";
import type { BillabilityState } from "../rules/types";

/** Combined RN + MSW cap: 4 hours = 16 fifteen-minute units per day (CPM ch. 11 §30.2.2). */
export const SIA_MAX_UNITS_PER_DAY = 16;
/** The SIA window is the last 7 days of life, the date of death included. */
export const SIA_WINDOW_DAYS = 7;
/** A unit is 15 minutes, so the per-unit rate is the CHC hourly rate / 4. */
const UNITS_PER_HOUR = 4;

export interface SiaDateSpan {
  readonly from: IsoDate;
  readonly to: IsoDate;
}

/**
 * The compliance parameters CMS leaves open (see the slice-1 design). Each carries a named default and is recorded in
 * every snapshot so a later change in interpretation is auditable. `visitDating` and `wageBasis` are applied by the
 * callers (the M8 reader dates a visit by its service date; claim assembly prices on the CHC labor share) and are
 * recorded here so the snapshot states every assumption in one place.
 */
export interface SiaPolicy {
  readonly unitTieBreak: UnitTieBreak;
  readonly videoEligible: boolean;
  readonly visitDating: "service_date";
  readonly wageBasis: "chc_labor_share";
}

export const DEFAULT_SIA_POLICY: SiaPolicy = {
  // The same constant the claim-line builder rounds with: the forecast and the lines cannot round differently.
  unitTieBreak: DEFAULT_UNIT_TIE_BREAK,
  videoEligible: false,
  visitDating: "service_date",
  wageBasis: "chc_labor_share",
};

export type SiaExclusionReason =
  | "outside_claim_window"
  | "ineligible_discipline"
  | "awaiting_cosignature"
  | "not_billable"
  | "modality_telephonic"
  | "non_visit_encounter"
  | "post_mortem"
  | "pm_modifier"
  | "modality_unconfirmed"
  | "modality_video"
  | "no_documented_time"
  | "non_rhc_day"
  | "over_daily_cap";

/** Where a visit's documented start/end came from (M8 `encounter.time_source`). */
export type SiaTimeSource = "evv" | "clinician";

export interface SiaVisitInput {
  readonly encounterId: string;
  readonly serviceDate: IsoDate;
  /** The M8 discipline; compared through `normalizeDiscipline`, so any casing works. */
  readonly discipline: string;
  readonly encounterType: string | null;
  readonly billability: BillabilityState;
  /** Documented visit minutes (start-to-end bracket); `null`/`0` = not documented. */
  readonly durationMinutes: number | null;
  /** The delivery mode the clinician recorded; `null` = unknown (legacy row). */
  readonly modality: VisitModality | null;
  /** True once the clinician confirmed the modality at signing. An unconfirmed visit is not counted. */
  readonly modalityConfirmed: boolean;
  /** Who supplied the documented bracket behind `durationMinutes` (recorded, never used to count): lets a reviewer see
   *  which units rest on times a clinician typed rather than an EVV bracket. Absent / `null` = none or unknown. */
  readonly timeSource?: SiaTimeSource | null;
  /** Reserved: a post-mortem visit is never SIA-eligible. No producer sets it yet. */
  readonly postMortem?: boolean;
  /** Reserved: a PM-modified line is never SIA-eligible. No producer sets it yet. */
  readonly modifiers?: readonly string[];
}

export interface SiaVisitOutcome {
  readonly encounterId: string;
  readonly serviceDate: IsoDate;
  readonly discipline: string;
  readonly durationMinutes: number | null;
  /** Who supplied `durationMinutes`; `null` = none or unknown. */
  readonly timeSource: SiaTimeSource | null;
  /** Units the visit is worth before the daily cap; `null` when it is not an eligible visit. */
  readonly units: number | null;
  /** Units actually payable after the daily cap. */
  readonly paidUnits: number;
  readonly counted: boolean;
  readonly excluded: SiaExclusionReason | null;
}

export interface SiaDayOutcome {
  readonly date: IsoDate;
  readonly eligibleUnits: number;
  readonly paidUnits: number;
  readonly truncatedUnits: number;
}

export interface SiaUnitsResult {
  /** `[death − 6, death]`; `null` when there is no date of death. */
  readonly window: SiaDateSpan | null;
  /** The window clamped to the claim's own service dates; `null` when they do not overlap. */
  readonly effectiveWindow: SiaDateSpan | null;
  readonly visits: readonly SiaVisitOutcome[];
  readonly days: readonly SiaDayOutcome[];
  readonly eligibleUnits: number;
  readonly paidUnits: number;
  readonly truncatedUnits: number;
  readonly policy: SiaPolicy;
}

export interface SiaUnitsInput {
  readonly visits: readonly SiaVisitInput[];
  readonly deathDate: IsoDate | null;
  /** Spans of ROUTINE HOME CARE only; a visit on any other level-of-care day is not payable. */
  readonly rhcPeriods: readonly SiaDateSpan[];
  /** The claim's own service dates: visits on other claims are reported but not counted here. */
  readonly claimWindow?: SiaDateSpan;
  readonly policy?: Partial<SiaPolicy>;
}

const EMPTY_RESULT = (policy: SiaPolicy): SiaUnitsResult => ({
  window: null,
  effectiveWindow: null,
  visits: [],
  days: [],
  eligibleUnits: 0,
  paidUnits: 0,
  truncatedUnits: 0,
  policy,
});

const SIA_DISCIPLINES: ReadonlySet<string> = new Set(["rn", "msw"]);

/** The first rule a visit fails, or `null` when it is eligible. Order is part of the contract (tested). */
function exclusionFor(
  v: SiaVisitInput,
  ctx: { policy: SiaPolicy; rhc: readonly SiaDateSpan[]; claimWindow: SiaDateSpan | undefined },
): SiaExclusionReason | null {
  const { policy, rhc, claimWindow } = ctx;
  if (claimWindow && !isWithinInclusive(v.serviceDate, claimWindow.from, claimWindow.to)) {
    return "outside_claim_window";
  }
  if (!SIA_DISCIPLINES.has(normalizeDiscipline(v.discipline) ?? "")) return "ineligible_discipline";
  if (v.billability === "awaiting_cosignature") return "awaiting_cosignature";
  if (v.billability === "not_billable") return "not_billable";
  if (v.encounterType === "telephonic" || v.modality === "telephonic") return "modality_telephonic";
  const code = visitCodeFor({ discipline: v.discipline, encounterType: v.encounterType });
  if (code === null || !isSiaVisitCode(code.revenueCode, code.hcpcsCode))
    return "non_visit_encounter";
  if (v.postMortem === true) return "post_mortem";
  if (v.modifiers?.includes("PM")) return "pm_modifier";
  if (v.modality === null || !v.modalityConfirmed) return "modality_unconfirmed";
  if (v.modality === "video" && !policy.videoEligible) return "modality_video";
  if ((v.durationMinutes ?? 0) <= 0) return "no_documented_time";
  if (!rhc.some((p) => isWithinInclusive(v.serviceDate, p.from, p.to))) return "non_rhc_day";
  return null;
}

const byDateThenId = (a: SiaVisitInput, b: SiaVisitInput): number =>
  a.serviceDate === b.serviceDate
    ? a.encounterId.localeCompare(b.encounterId)
    : a.serviceDate.localeCompare(b.serviceDate);

/**
 * Decide, for every visit in the last-7-days window, whether it counts toward the SIA and for how many units.
 * Visits fill each day's 16-unit budget in (encounter id) order, so the allocation is deterministic.
 */
export function evaluateSiaUnits(input: SiaUnitsInput): SiaUnitsResult {
  const policy: SiaPolicy = { ...DEFAULT_SIA_POLICY, ...input.policy };
  if (input.deathDate === null) return EMPTY_RESULT(policy);

  const window: SiaDateSpan = {
    from: addDaysIso(input.deathDate, -(SIA_WINDOW_DAYS - 1)),
    to: input.deathDate,
  };
  const effective = input.claimWindow
    ? {
        from: maxIso(window.from, input.claimWindow.from),
        to: minIso(window.to, input.claimWindow.to),
      }
    : window;
  const ctx = { policy, rhc: input.rhcPeriods, claimWindow: input.claimWindow };

  const budgetByDay = new Map<IsoDate, { eligible: number; paid: number }>();
  const visits: SiaVisitOutcome[] = [];
  for (const v of input.visits
    .filter((x) => isWithinInclusive(x.serviceDate, window.from, window.to))
    .sort(byDateThenId)) {
    const excluded = exclusionFor(v, ctx);
    const units =
      excluded === null ? visitUnitsForMinutes(v.durationMinutes ?? 0, policy.unitTieBreak) : null;
    let paidUnits = 0;
    if (units !== null) {
      const day = budgetByDay.get(v.serviceDate) ?? { eligible: 0, paid: 0 };
      paidUnits = Math.min(units, SIA_MAX_UNITS_PER_DAY - day.paid);
      budgetByDay.set(v.serviceDate, {
        eligible: day.eligible + units,
        paid: day.paid + paidUnits,
      });
    }
    visits.push({
      encounterId: v.encounterId,
      serviceDate: v.serviceDate,
      discipline: normalizeDiscipline(v.discipline) ?? v.discipline,
      durationMinutes: v.durationMinutes,
      timeSource: v.timeSource ?? null,
      units,
      paidUnits,
      counted: paidUnits > 0,
      excluded: units !== null && paidUnits === 0 ? "over_daily_cap" : excluded,
    });
  }

  const days: SiaDayOutcome[] = [...budgetByDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => ({
      date,
      eligibleUnits: d.eligible,
      paidUnits: d.paid,
      truncatedUnits: d.eligible - d.paid,
    }));
  const sum = (pick: (d: SiaDayOutcome) => number) => days.reduce((total, d) => total + pick(d), 0);
  return {
    window,
    effectiveWindow: effective.from <= effective.to ? effective : null,
    visits,
    days,
    eligibleUnits: sum((d) => d.eligibleUnits),
    paidUnits: sum((d) => d.paidUnits),
    truncatedUnits: sum((d) => d.truncatedUnits),
    policy,
  };
}

/** The add-on in cents: `units x CHC hourly / 4`, rounded once on the total (never per visit or per day). */
export function siaAmountCents(units: number, chcHourlyRateCents: Cents): Cents {
  return lineChargeCents(units / UNITS_PER_HOUR, chcHourlyRateCents);
}

export interface SiaForecastInput {
  readonly visits: readonly SiaVisitInput[];
  readonly hypotheticalDeathDate: IsoDate;
  readonly rhcPeriods: readonly SiaDateSpan[];
  readonly claimWindow?: SiaDateSpan;
  readonly policy?: Partial<SiaPolicy>;
  /** The wage-adjusted CHC hourly rate when it is known; the forecast still returns units without it. */
  readonly chcHourlyRateCents?: Cents;
}

export type SiaForecast = SiaUnitsResult & { readonly amountCents: Cents | null };

/** What the add-on would be if the patient died on `hypotheticalDeathDate` (the pre-death tracker's number). */
export function forecastSia(input: SiaForecastInput): SiaForecast {
  const result = evaluateSiaUnits({ ...input, deathDate: input.hypotheticalDeathDate });
  return {
    ...result,
    amountCents:
      input.chcHourlyRateCents === undefined
        ? null
        : siaAmountCents(result.paidUnits, input.chcHourlyRateCents),
  };
}

/** A claim line as far as the SIA cares: the MAC prices the add-on from these, not from our encounters. */
export interface SiaLineInput {
  readonly serviceDate: IsoDate;
  readonly revenueCode: string;
  readonly hcpcs: string | null;
  readonly modifiers: readonly string[];
  readonly unitCount: number;
  readonly levelOfCare: LevelOfCare;
}

export interface SiaLineUnits {
  readonly paidUnits: number;
  readonly days: readonly {
    readonly date: IsoDate;
    readonly units: number;
    readonly paidUnits: number;
  }[];
}

/**
 * The units Medicare will see on the claim's lines inside `window`: SIA-coded lines on RHC days, no PM modifier,
 * summed per day and capped at 16. The validation rule holds our counted units to this number, because the MAC
 * pays from the lines.
 */
export function siaUnitsFromLines(
  lines: readonly SiaLineInput[],
  window: SiaDateSpan | null,
): SiaLineUnits {
  if (window === null) return { paidUnits: 0, days: [] };
  const unitsByDay = new Map<IsoDate, number>();
  for (const l of lines) {
    if (
      l.levelOfCare === "routine_home_care" &&
      isSiaVisitCode(l.revenueCode, l.hcpcs) &&
      !l.modifiers.includes("PM") &&
      isWithinInclusive(l.serviceDate, window.from, window.to)
    ) {
      unitsByDay.set(l.serviceDate, (unitsByDay.get(l.serviceDate) ?? 0) + l.unitCount);
    }
  }
  const days = [...unitsByDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, units]) => ({ date, units, paidUnits: Math.min(units, SIA_MAX_UNITS_PER_DAY) }));
  return { paidUnits: days.reduce((total, d) => total + d.paidUnits, 0), days };
}
