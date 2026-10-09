// @wardenx/billing — the tenant wage-index entry (`tenant_wage_index`, F-211) for a provider, derived from the CMS
// hospice geography instead of keyed by hand: the provider's ZIP is placed in its CBSA / rural area for the fiscal
// year (the same resolver the claim's value code 61 uses) and the published index for that area is taken from
// `hospice_cbsa_wage_index`. PURE. The CCN and ZIP are INPUTS — nothing here is a production default.
import type { HospiceAreaResolution } from "./index";

export interface WageIndexSeedInput {
  readonly ccn: string;
  readonly providerPostalCode: string;
  readonly fiscalYearStarting: number;
  readonly area: HospiceAreaResolution;
}

export interface WageIndexSeedBody {
  readonly ccn: string;
  readonly fiscalYearStarting: number;
  readonly cbsaCode: string;
  readonly factorDecimal: string;
  readonly sourceReference: string;
}

const CCN = /^[0-9A-Za-z]{6}$/;
const FACTOR = /^\d(\.\d{1,4})?$/;

export function wageIndexSeedBody(input: WageIndexSeedInput): WageIndexSeedBody {
  if (!CCN.test(input.ccn)) throw new RangeError(`CCN '${input.ccn}' is not 6 characters`);
  const { area } = input;
  if (area.status !== "resolved") {
    throw new RangeError(
      `ZIP ${input.providerPostalCode} could not be placed in a hospice wage-index area (${area.reason}); nothing was seeded`,
    );
  }
  if (area.wageIndex === null || !FACTOR.test(area.wageIndex)) {
    throw new RangeError(
      `CMS publishes no wage index for area ${area.cbsaCode} in fiscal year starting ${input.fiscalYearStarting}`,
    );
  }
  return {
    ccn: input.ccn,
    fiscalYearStarting: input.fiscalYearStarting,
    cbsaCode: area.cbsaCode,
    factorDecimal: area.wageIndex,
    sourceReference:
      `CMS FY${input.fiscalYearStarting + 1} hospice wage index, area ${area.cbsaCode} ` +
      `(provider ZIP ${input.providerPostalCode.slice(0, 5)}; hospice_cbsa_wage_index)`,
  };
}
