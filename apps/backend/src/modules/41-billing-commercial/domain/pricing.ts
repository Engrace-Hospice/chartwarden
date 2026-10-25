// apps/backend/src/modules/41-billing-commercial/domain/pricing.ts — PURE: turn the level-of-care periods inside a claim
// window into priced claim lines from the contract rate rows in effect (ADR-0100 D6). No I/O, no clock.
//
// The rate table is NOT bounded by its plan's period in the database (migration 1260), so a period is split wherever the
// rate row in effect changes, and a stretch with no rate in effect becomes an UNPRICED line that the
// `contract_rate_in_effect` rule blocks on. Nothing is inferred from Medicare's rules: the revenue code and basis are the
// contract's own. A percent-of-charges contract cannot be priced (no chargemaster exists yet); per-hour needs whole
// documented continuous-care hours. Both are blocked rather than guessed.
import {
  COMMERCIAL_REVENUE_CODE_BY_LEVEL_OF_CARE,
  type CommercialHospiceLevelOfCare,
  type CommercialRateBasis,
} from "@chartwarden/types";
import { addDays, daysInclusive, maxDate, minDate } from "./dates";

export interface LevelOfCarePeriodFact {
  readonly levelOfCare: CommercialHospiceLevelOfCare;
  readonly from: string;
  readonly to: string;
  /** Documented continuous-home-care hours for the period; `null` = not documented (no producer binds this yet). */
  readonly chcDocumentedHours: number | null;
}

export interface ContractRateFact {
  readonly id: string;
  readonly levelOfCare: CommercialHospiceLevelOfCare;
  readonly revenueCode: string;
  readonly rateBasis: CommercialRateBasis;
  readonly rateCents: number | null;
  readonly percentOfCharges: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

export type UnpricedReason =
  | "no_contract_rate"
  | "percent_of_charges_needs_charge_source"
  | "chc_hours_not_documented";

export interface PricedLine {
  readonly lineNumber: number;
  readonly levelOfCare: CommercialHospiceLevelOfCare;
  readonly revenueCode: string;
  readonly hcpcsCode: string | null;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  readonly units: number;
  readonly unitRateCents: number | null;
  readonly lineChargeCents: number;
  readonly contractRateId: string | null;
  readonly unpricedReason: UnpricedReason | null;
}

interface Segment {
  readonly from: string;
  readonly to: string;
  readonly rate: ContractRateFact | null;
}

/** Split one level-of-care stretch by the rate rows of that level in effect. */
function segmentsFor(
  period: { from: string; to: string },
  rates: readonly ContractRateFact[],
): Segment[] {
  const out: Segment[] = [];
  let cursor = period.from;
  while (cursor <= period.to) {
    const covering = rates.find(
      (r) => r.effectiveFrom <= cursor && (r.effectiveTo === null || r.effectiveTo >= cursor),
    );
    if (covering) {
      const end = minDate(period.to, covering.effectiveTo ?? period.to);
      out.push({ from: cursor, to: end, rate: covering });
      cursor = addDays(end, 1);
      continue;
    }
    const nextStart = rates
      .map((r) => r.effectiveFrom)
      .filter((d) => d > cursor)
      .sort()[0];
    const end = nextStart === undefined ? period.to : minDate(period.to, addDays(nextStart, -1));
    out.push({ from: cursor, to: end, rate: null });
    cursor = addDays(end, 1);
  }
  return out;
}

function priceSegment(
  seg: Segment,
  period: LevelOfCarePeriodFact,
  segmentCountInPeriod: number,
): Omit<PricedLine, "lineNumber" | "hcpcsCode" | "levelOfCare"> {
  const days = daysInclusive(seg.from, seg.to);
  const base = {
    serviceFrom: seg.from,
    serviceTo: seg.to,
    revenueCode:
      seg.rate?.revenueCode ?? COMMERCIAL_REVENUE_CODE_BY_LEVEL_OF_CARE[period.levelOfCare],
    contractRateId: seg.rate?.id ?? null,
  };
  const unpriced = (unpricedReason: UnpricedReason, units = days) => ({
    ...base,
    units,
    unitRateCents: null,
    lineChargeCents: 0,
    unpricedReason,
  });
  const rate = seg.rate;
  if (rate === null) return { ...unpriced("no_contract_rate"), contractRateId: null };
  if (rate.rateBasis === "percent_of_charges") {
    return unpriced("percent_of_charges_needs_charge_source");
  }
  if (rate.rateCents === null) return unpriced("no_contract_rate");
  if (rate.rateBasis === "per_diem") {
    return {
      ...base,
      units: days,
      unitRateCents: rate.rateCents,
      lineChargeCents: rate.rateCents * days,
      unpricedReason: null,
    };
  }
  // per_hour: continuous home care only (database CHECK); whole documented hours, and only when the period was not split.
  const hours = period.chcDocumentedHours;
  if (segmentCountInPeriod !== 1 || hours === null || !Number.isInteger(hours) || hours < 1) {
    return unpriced("chc_hours_not_documented");
  }
  return {
    ...base,
    units: hours,
    unitRateCents: rate.rateCents,
    lineChargeCents: rate.rateCents * hours,
    unpricedReason: null,
  };
}

/** Price every level-of-care period inside `[window.from, window.to]`; lines are numbered from 1 in date order. */
export function priceClaimLines(args: {
  readonly window: { readonly from: string; readonly to: string };
  readonly periods: readonly LevelOfCarePeriodFact[];
  readonly rates: readonly ContractRateFact[];
  /** Set only when the plan requires site-of-service HCPCS lines; `null` leaves SV2-02 empty. */
  readonly hcpcsCode: string | null;
}): PricedLine[] {
  const lines: PricedLine[] = [];
  const ordered = [...args.periods].sort((a, b) =>
    a.from < b.from ? -1 : a.from > b.from ? 1 : 0,
  );
  for (const period of ordered) {
    const from = maxDate(period.from, args.window.from);
    const to = minDate(period.to, args.window.to);
    if (from > to) continue;
    const rates = args.rates
      .filter((r) => r.levelOfCare === period.levelOfCare)
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
    const segments = segmentsFor({ from, to }, rates);
    for (const seg of segments) {
      lines.push({
        lineNumber: lines.length + 1,
        levelOfCare: period.levelOfCare,
        hcpcsCode: args.hcpcsCode,
        ...priceSegment(seg, period, segments.length),
      });
    }
  }
  return lines;
}

/** The contract's expected payment: the sum of the priced lines, or `null` while any line is unpriced. */
export function expectedPaymentCents(lines: readonly PricedLine[]): number | null {
  if (lines.length === 0 || lines.some((l) => l.unpricedReason !== null)) return null;
  return lines.reduce((sum, l) => sum + l.lineChargeCents, 0);
}
