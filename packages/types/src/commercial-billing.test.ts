import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMMERCIAL_AUTHORIZATION_REQUIREMENT_VALUES,
  COMMERCIAL_CLAIM_FILING_INDICATOR_VALUES,
  COMMERCIAL_ELIGIBILITY_OUTCOME_VALUES,
  COMMERCIAL_ELIGIBILITY_STALENESS_POLICY_VALUES,
  COMMERCIAL_ENROLLMENT_STATUS_VALUES,
  DEFAULT_ELIGIBILITY_MAX_AGE_DAYS,
  DEFAULT_ELIGIBILITY_STALENESS_POLICY,
  MAX_ELIGIBILITY_MAX_AGE_DAYS,
  COMMERCIAL_HOSPICE_LEVEL_OF_CARE_VALUES,
  COMMERCIAL_RATE_BASIS_VALUES,
  COMMERCIAL_REVENUE_CODE_BY_LEVEL_OF_CARE,
  isCommercialClaimFilingIndicator,
} from "./commercial-billing";

const MIGRATION = readFileSync(
  join(__dirname, "../../db/migrations/1260_m41_commercial_payer_plan.sql"),
  "utf8",
);

const MIGRATION_1265 = readFileSync(
  join(__dirname, "../../db/migrations/1265_m41_commercial_enrollment_eligibility.sql"),
  "utf8",
);

/** The values of `"column" IN ('a','b',...)` in the migration, sorted. */
function checkListFor(column: string, sql: string = MIGRATION): string[] {
  const m = new RegExp(`"${column}"[^\\n]*? IN \\(([^)]*)\\)`).exec(sql);
  if (!m) throw new Error(`no CHECK ... IN (...) for ${column}`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!).sort();
}

describe("M41 commercial billing code-side mirrors", () => {
  it("mirror the migration CHECK lists exactly", () => {
    expect([...COMMERCIAL_CLAIM_FILING_INDICATOR_VALUES].sort()).toEqual(
      checkListFor("claim_filing_indicator"),
    );
    expect([...COMMERCIAL_AUTHORIZATION_REQUIREMENT_VALUES].sort()).toEqual(
      checkListFor("authorization_requirement"),
    );
    expect([...COMMERCIAL_HOSPICE_LEVEL_OF_CARE_VALUES].sort()).toEqual(
      checkListFor("level_of_care"),
    );
    expect([...COMMERCIAL_RATE_BASIS_VALUES].sort()).toEqual(checkListFor("rate_basis"));
  });

  it("mirror the 1265 enrollment and eligibility CHECK lists and defaults exactly", () => {
    expect([...COMMERCIAL_ENROLLMENT_STATUS_VALUES].sort()).toEqual(
      checkListFor("status", MIGRATION_1265),
    );
    expect([...COMMERCIAL_ELIGIBILITY_OUTCOME_VALUES].sort()).toEqual(
      checkListFor("outcome", MIGRATION_1265),
    );
    expect([...COMMERCIAL_ELIGIBILITY_STALENESS_POLICY_VALUES].sort()).toEqual(
      checkListFor("eligibility_staleness_policy", MIGRATION_1265),
    );
    expect(DEFAULT_ELIGIBILITY_STALENESS_POLICY).toBe("warn");
    expect(MIGRATION_1265).toContain(`"eligibility_staleness_policy" text NOT NULL DEFAULT 'warn'`);
    expect(MIGRATION_1265).toContain(
      `"eligibility_max_age_days" smallint NOT NULL DEFAULT ${DEFAULT_ELIGIBILITY_MAX_AGE_DAYS} CHECK ("eligibility_max_age_days" BETWEEN 1 AND ${MAX_ELIGIBILITY_MAX_AGE_DAYS})`,
    );
  });

  it("never admits Medicare, Medicaid, Medicare risk or self-pay filing indicators", () => {
    for (const code of ["MA", "MB", "MC", "16", "09", "10", "TV"]) {
      expect(isCommercialClaimFilingIndicator(code)).toBe(false);
    }
    for (const code of ["12", "13", "14", "15", "HM", "CI", "BL"]) {
      expect(isCommercialClaimFilingIndicator(code)).toBe(true);
    }
  });

  it("maps each level of care to its hospice revenue code", () => {
    expect(COMMERCIAL_REVENUE_CODE_BY_LEVEL_OF_CARE).toEqual({
      routine_home_care: "0651",
      continuous_home_care: "0652",
      inpatient_respite: "0655",
      general_inpatient: "0656",
    });
  });
});
