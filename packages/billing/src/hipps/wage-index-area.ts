// @wardenx/billing — which wage index prices which level of care (pure).
//
// The hospice wage index is applied to the labor share of the per-diem by the GEOGRAPHIC AREA WHERE THE CARE IS
// FURNISHED, not by where the hospice is headquartered (SSA §1814(i)(2)(D); 42 CFR 418.306(c); CMS Pub. 100-04 ch. 11
// §30.3 — which is why the claim reports value code 61 = the CBSA of the beneficiary's residence for home care and
// G8 = the CBSA of the inpatient facility for inpatient care). So:
//   routine home care + continuous home care     → the BENEFICIARY's residence area   (value code 61)
//   general inpatient + inpatient respite care   → the area of the FACILITY delivering the care (value code G8)
// When the caller supplies no area factors (the CBSA geography is not bound) the provider factor is used unchanged;
// when it supplies them but the one a level of care needs is missing, that is an error — never a silent fallback to
// the provider's index, which would misprice the claim.
import type { LevelOfCare } from "../contracts";

export interface WageIndexAreaFactors {
  /** Wage index of the beneficiary's residence area (value code 61); `null` = could not be resolved. */
  readonly residence: string | null;
  /** Wage index of the inpatient facility's area (value code G8); `null` = could not be resolved. */
  readonly facility: string | null;
}

export class WageIndexAreaError extends Error {
  constructor(
    readonly levelOfCare: LevelOfCare,
    readonly source: "residence" | "facility",
  ) {
    super(
      `no wage index is available for the ${source} area, which prices ${levelOfCare} ` +
        `(value code ${source === "residence" ? "61" : "G8"})`,
    );
    this.name = "WageIndexAreaError";
  }
}

const HOME_LEVELS: ReadonlySet<LevelOfCare> = new Set([
  "routine_home_care",
  "continuous_home_care",
]);

/** The wage-index factor (decimal string) that prices `levelOfCare`. */
export function wageIndexFactorForLevelOfCare(
  levelOfCare: LevelOfCare,
  providerFactor: string,
  areas: WageIndexAreaFactors | undefined,
): string {
  if (areas === undefined) return providerFactor;
  const source = HOME_LEVELS.has(levelOfCare) ? "residence" : "facility";
  const factor = areas[source];
  if (factor === null) throw new WageIndexAreaError(levelOfCare, source);
  return factor;
}
