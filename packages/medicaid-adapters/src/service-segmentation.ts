import type { IsoDate } from "./contracts";

export type HospiceQuantityEvidence =
  | {
      readonly kind: "daily";
      readonly units: number;
      readonly sourceRecordId: string;
      readonly verified: boolean;
    }
  | {
      readonly kind: "hourly";
      /** Exact clinical duration. This is not rounded or converted to payer-billable units here. */
      readonly minutes: number;
      readonly sourceRecordId: string;
      readonly verified: boolean;
    };

export type HospiceFactDimension = "loc" | "coverage" | "program" | "rate" | "policy";
export type HospiceFactStatus = "verified" | "candidate" | "unverified";

export interface EffectiveHospiceFact {
  readonly dimension: HospiceFactDimension;
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly identity: string;
  readonly status: HospiceFactStatus;
  readonly sourceRecordId: string;
}

export interface HospiceServiceSegment {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly facts: Partial<Record<HospiceFactDimension, EffectiveHospiceFact>>;
  readonly quantity: HospiceQuantityEvidence | null;
  readonly reasonCodes: readonly string[];
  readonly priceable: boolean;
}

const DAY_MS = 86_400_000;
const utc = (date: IsoDate): number => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Number.NaN;
  const millis = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isFinite(millis) && new Date(millis).toISOString().slice(0, 10) === date
    ? millis
    : Number.NaN;
};
const dateAt = (millis: number): IsoDate => new Date(millis).toISOString().slice(0, 10);
const nextDay = (date: IsoDate): IsoDate => dateAt(utc(date) + DAY_MS);

const DIMENSIONS: readonly HospiceFactDimension[] = [
  "loc",
  "coverage",
  "program",
  "rate",
  "policy",
];

/**
 * Splits an inclusive hospice claim window at every supplied effective-date boundary. A returned span is
 * priceable only when exactly one verified fact for each required dimension covers it and its quantity
 * is verified. The function never chooses the first of conflicting facts or derives hourly care from dates.
 */
export function segmentHospiceServiceWindow(input: {
  readonly from: IsoDate;
  readonly to: IsoDate;
  readonly facts: readonly EffectiveHospiceFact[];
  readonly quantityByDate: ReadonlyMap<IsoDate, HospiceQuantityEvidence>;
  readonly unknownPolicyBoundaries?: boolean;
}): readonly HospiceServiceSegment[] {
  const start = utc(input.from);
  const end = utc(input.to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    throw new RangeError("invalid inclusive hospice service window");
  }
  for (const fact of input.facts) {
    if (!Number.isFinite(utc(fact.from)) || !Number.isFinite(utc(fact.to)) || fact.from > fact.to) {
      throw new RangeError(`invalid effective range for ${fact.dimension} fact`);
    }
  }

  const boundaries = new Set<number>([start, end + DAY_MS]);
  for (const fact of input.facts) {
    const from = utc(fact.from);
    const afterTo = utc(fact.to) + DAY_MS;
    if (from > start && from <= end) boundaries.add(from);
    if (afterTo > start && afterTo <= end) boundaries.add(afterTo);
  }
  for (const date of input.quantityByDate.keys()) {
    const value = utc(date);
    if (!Number.isFinite(value) || value < start || value > end) {
      throw new RangeError("quantity evidence date falls outside the claim window");
    }
  }
  for (const quantity of input.quantityByDate.values()) {
    if (
      (quantity.kind === "daily" && (!Number.isFinite(quantity.units) || quantity.units <= 0)) ||
      (quantity.kind === "hourly" &&
        (!Number.isInteger(quantity.minutes) || quantity.minutes <= 0 || quantity.minutes > 1440))
    ) {
      throw new RangeError("invalid clinical quantity evidence");
    }
  }

  const points = [...boundaries].sort((a, b) => a - b);
  const result: HospiceServiceSegment[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const from = dateAt(points[i]!);
    const to = dateAt(points[i + 1]! - DAY_MS);
    const selected: Partial<Record<HospiceFactDimension, EffectiveHospiceFact>> = {};
    const reasons: string[] = [];

    for (const dimension of DIMENSIONS) {
      const matching = input.facts.filter(
        (fact) => fact.dimension === dimension && fact.from <= from && fact.to >= to,
      );
      if (matching.length === 0) {
        reasons.push(`MISSING_${dimension.toUpperCase()}_FACT`);
      } else if (matching.length > 1) {
        reasons.push(`AMBIGUOUS_${dimension.toUpperCase()}_FACT`);
      } else {
        const fact = matching[0]!;
        selected[dimension] = fact;
        if (fact.status !== "verified") reasons.push(`UNVERIFIED_${dimension.toUpperCase()}_FACT`);
      }
    }
    if (input.unknownPolicyBoundaries) reasons.push("POLICY_BOUNDARIES_UNQUALIFIED");

    const quantity = input.quantityByDate.get(from) ?? null;
    if (!quantity) {
      reasons.push("CLINICAL_QUANTITY_UNRESOLVED");
    } else if (to !== from) {
      // Quantities are daily evidence. Merge only after confirming a complete, identical basis for each day.
      const perDay: HospiceQuantityEvidence[] = [];
      for (let date = from; date <= to; date = nextDay(date)) {
        const daily = input.quantityByDate.get(date);
        if (!daily) break;
        perDay.push(daily);
      }
      if (perDay.length !== Math.round((utc(to) - utc(from)) / DAY_MS) + 1) {
        reasons.push("CLINICAL_QUANTITY_UNRESOLVED");
      } else if (perDay.some((entry) => entry.kind !== quantity.kind)) {
        reasons.push("CLINICAL_QUANTITY_BASIS_CONFLICT");
      } else if (quantity.kind === "daily") {
        const entries = perDay as Extract<HospiceQuantityEvidence, { kind: "daily" }>[];
        if (entries.some((entry) => !entry.verified)) reasons.push("CLINICAL_QUANTITY_UNVERIFIED");
        result.push({
          from,
          to,
          facts: selected,
          quantity: {
            kind: "daily",
            units: entries.reduce((sum, entry) => sum + entry.units, 0),
            sourceRecordId: entries.map((entry) => entry.sourceRecordId).join(","),
            verified: entries.every((entry) => entry.verified),
          },
          reasonCodes: [...new Set(reasons)],
          priceable: reasons.length === 0,
        });
        continue;
      } else {
        const entries = perDay as Extract<HospiceQuantityEvidence, { kind: "hourly" }>[];
        if (entries.some((entry) => !entry.verified)) reasons.push("CLINICAL_QUANTITY_UNVERIFIED");
        result.push({
          from,
          to,
          facts: selected,
          quantity: {
            kind: "hourly",
            minutes: entries.reduce((sum, entry) => sum + entry.minutes, 0),
            sourceRecordId: entries.map((entry) => entry.sourceRecordId).join(","),
            verified: entries.every((entry) => entry.verified),
          },
          reasonCodes: [...new Set(reasons)],
          priceable: reasons.length === 0,
        });
        continue;
      }
    }
    if (quantity && !quantity.verified) reasons.push("CLINICAL_QUANTITY_UNVERIFIED");
    result.push({
      from,
      to,
      facts: selected,
      quantity,
      reasonCodes: [...new Set(reasons)],
      priceable: reasons.length === 0,
    });
  }
  return result;
}
