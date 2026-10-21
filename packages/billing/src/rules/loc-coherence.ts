// @chartwarden/billing — §4.5 rule `level_of_care_coherence` (loc, error, regulatory). Every claim line's
// revenue code + Q-code + level-of-care must align with the LOC period active on that service date; CHC
// requires 8+ documented hours/day, GIP requires admission criteria documented (D7 / 42 CFR §418.302).
// Reads the resolved `lines` + `levelOfCarePeriods` snapshots. PURE: reads ctx only.
import { isVisitRevenueCode } from "../claim-lines/visit-codes";
import type { LevelOfCare } from "../contracts";
import { locPeriodCoveringDate, paramStringMap } from "./_util";
import { G0679_HCPCS } from "./f2f-telehealth-g0679";
import type { Rule } from "./types";
import { fail, pass } from "./types";

const KEY = "level_of_care_coherence";

/** CMS hospice revenue codes by level-of-care (the §4.5 default; tenant-overridable via params). */
const REVENUE_CODE_BY_LOC: Readonly<Record<LevelOfCare, string>> = {
  routine_home_care: "0651",
  continuous_home_care: "0652",
  inpatient_respite_care: "0655",
  general_inpatient_care: "0656",
};

/** CHC requires at least 8 hours of documented care per day (CMS continuous-home-care criterion). */
const CHC_MIN_DOCUMENTED_HOURS = 8;

export const levelOfCareCoherence: Rule = {
  key: KEY,
  version: 1,
  category: "loc",
  title: "Level-of-care coherence per service date",
  description:
    "Each claim line's revenue code, Q-code and level-of-care must match the active LOC period on its " +
    "service date; CHC requires 8+ documented hours/day, GIP requires documented admission criteria.",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  defaultParameters: {
    revenueCodeByLoc: REVENUE_CODE_BY_LOC,
    chcMinDocumentedHours: CHC_MIN_DOCUMENTED_HOURS,
  },
  check: (ctx, params) => {
    const revenueCodeByLoc = paramStringMap(params, "revenueCodeByLoc", REVENUE_CODE_BY_LOC);
    const chcMinHours =
      typeof params.chcMinDocumentedHours === "number"
        ? (params.chcMinDocumentedHours as number)
        : CHC_MIN_DOCUMENTED_HOURS;

    const defects: string[] = [];
    for (const line of ctx.lines) {
      // A G0679 telehealth-F2F line (rev 0657) is not a per-diem LOC line — `f2f_telehealth_g0679` owns it.
      if (line.hcpcs === G0679_HCPCS) continue;
      const period = locPeriodCoveringDate(ctx.levelOfCarePeriods, line.serviceDate);
      if (period === undefined) {
        defects.push(`${line.serviceDate}: no LOC period`);
        continue;
      }
      if (line.levelOfCare !== period.levelOfCare) {
        defects.push(`${line.serviceDate}: line LOC ≠ period LOC`);
        continue;
      }
      // A visit line (042x-057x, ch. 11 §30.3) rides the covering period like a per-diem line but is coded by
      // discipline, not by level of care — it must sit in the period (above), not carry its revenue code.
      const expectedRevenue = isVisitRevenueCode(line.revenueCode)
        ? undefined
        : revenueCodeByLoc[line.levelOfCare];
      if (expectedRevenue !== undefined && line.revenueCode !== expectedRevenue) {
        defects.push(
          `${line.serviceDate}: revenue ${line.revenueCode} ≠ expected ${expectedRevenue}`,
        );
      }
      if (
        period.levelOfCare === "continuous_home_care" &&
        (period.chcDocumentedHours === null || period.chcDocumentedHours < chcMinHours)
      ) {
        defects.push(`${line.serviceDate}: CHC < ${chcMinHours} documented hours`);
      }
      if (
        period.levelOfCare === "general_inpatient_care" &&
        period.gipAdmissionCriteriaDocumented !== true
      ) {
        defects.push(`${line.serviceDate}: GIP admission criteria undocumented`);
      }
    }
    if (defects.length === 0) {
      return pass(
        KEY,
        "error",
        "Every claim line's LOC/revenue/Q-code coheres with its LOC period.",
      );
    }
    return fail(
      KEY,
      "error",
      `${defects.length} claim line(s) have level-of-care coherence defects.`,
      {
        summary:
          "Correct the line's revenue/Q-code/LOC or document CHC hours / GIP criteria (M8/M6).",
        blameTarget: "claim_line",
        fixAction: "edit_in_m8",
      },
      { defectCount: defects.length, firstDefect: defects[0] ?? "" },
    );
  },
};
