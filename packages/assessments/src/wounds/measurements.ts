// @chartwarden/assessments — computed wound measures. Display only: nothing here is stored, so a corrected
// measurement can never leave a stale area or percentage behind.

const AREA_DECIMALS = 100;
const PERCENT_DECIMALS = 10;
const PERCENT = 100;

const present = (v: number | null | undefined): v is number => v !== null && v !== undefined;

/** Length times width in cm^2, two decimals (no float noise); null unless both are recorded. */
export function woundAreaCm2(
  lengthCm: number | null | undefined,
  widthCm: number | null | undefined,
): number | null {
  if (!present(lengthCm) || !present(widthCm)) return null;
  return Math.round(lengthCm * widthCm * AREA_DECIMALS) / AREA_DECIMALS;
}

/** Percent change from the earlier area to the later one, one decimal; negative = smaller. Null without a non-zero baseline. */
export function percentAreaChange(
  earlierArea: number | null | undefined,
  laterArea: number | null | undefined,
): number | null {
  if (!present(earlierArea) || !present(laterArea) || earlierArea === 0) return null;
  const change = ((laterArea - earlierArea) / earlierArea) * PERCENT;
  return Math.round(change * PERCENT_DECIMALS) / PERCENT_DECIMALS;
}

export interface MeasuredObservation {
  readonly id: string;
  readonly observedAt: string;
  readonly lengthCm?: number | null;
  readonly widthCm?: number | null;
}

export interface ComputedMeasures {
  readonly areaCm2: number | null;
  /** Against the last earlier observation that has an area (an unmeasured visit is skipped); null when there is none. */
  readonly areaChangePercent: number | null;
  /** `observedAt` of the observation the percentage is against. */
  readonly areaChangeSinceObservedAt: string | null;
}

/**
 * Adds the computed measures to one wound's observations. Returns them oldest first whatever order they arrive in
 * (observed time, then id), the order the percentage needs.
 */
export function withComputedMeasures<T extends MeasuredObservation>(
  observations: readonly T[],
): (T & ComputedMeasures)[] {
  const oldestFirst = [...observations].sort((a, b) =>
    a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : a.id < b.id ? -1 : 1,
  );
  let baseline: { area: number; observedAt: string } | null = null;
  return oldestFirst.map((o) => {
    const areaCm2 = woundAreaCm2(o.lengthCm, o.widthCm);
    const areaChangePercent = baseline ? percentAreaChange(baseline.area, areaCm2) : null;
    const computed: ComputedMeasures = {
      areaCm2,
      areaChangePercent,
      areaChangeSinceObservedAt:
        baseline && areaChangePercent !== null ? baseline.observedAt : null,
    };
    if (areaCm2 !== null) baseline = { area: areaCm2, observedAt: o.observedAt };
    return { ...o, ...computed };
  });
}
