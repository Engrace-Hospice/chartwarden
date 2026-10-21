// @chartwarden/billing — which wage index prices which level of care (pure).
//
// The Medicare Pricer wage-adjusts a hospice claim with the CBSA the claim REPORTS, not the hospice's own location:
// CMS Pub. 100-04 ch. 11 §30.3 ("Value Codes and Amounts") defines value code 61 as the MSA/CBSA (or rural State
// code) "of the location where the hospice service is delivered" for routine and continuous home care, and G8 as the
// CBSA "of the facility where inpatient hospice services are delivered" for general inpatient and inpatient respite
// care; the hospice reports the CBSA of the residence at the END of the billing period (61) and of the LATEST facility
// that served the beneficiary (G8). The same section's Pricer input record names them: BENE-CBSA ("used to wage-adjust
// home levels of care", copied from value code 61) and PROV-CBSA ("used to wage-adjust inpatient levels of care",
// copied from value code G8). (42 CFR 418.306(c) itself only says the labor market is defined by OMB CBSAs, that the
// contractor adjusts the rates for local wage differences, and the 5% cap on year-over-year decreases.) So:
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
