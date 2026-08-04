// @wardenx/billing — §4.5 rule `bereavement_discharge_legitimacy` (discharge, error, regulatory).
// Discharge claims must carry a discharge reason + date; bereavement-period lines (revenue code 0942)
// are restricted to allowable post-death services per the CMS rule (bereavement is a non-covered,
// non-reimbursable service — it must not appear as a billable charge). Reads the resolved claim
// discharge facts + line revenue codes. PURE: reads ctx only.
import type { Rule } from "./types";
import { fail, pass } from "./types";

const KEY = "bereavement_discharge_legitimacy";

/** UB-04 revenue code for bereavement services (non-covered for Medicare hospice reimbursement). */
const BEREAVEMENT_REVENUE_CODE = "0942";

/** Discharge-bearing Types of Bill (admit-through-discharge and last-interim-before-discharge). */
const DISCHARGE_TOBS: readonly string[] = ["811", "814"];

export const bereavementDischargeLegitimacy: Rule = {
  key: KEY,
  version: 1,
  category: "discharge",
  title: "Discharge / bereavement legitimacy",
  description:
    "Discharge claims must carry a discharge reason and date; bereavement-period lines (revenue code " +
    "0942) are non-covered and must not be billed as a reimbursable charge.",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  defaultParameters: { bereavementRevenueCode: BEREAVEMENT_REVENUE_CODE },
  check: (ctx, params) => {
    const c = ctx.claim;
    const bereavementCode =
      typeof params.bereavementRevenueCode === "string"
        ? (params.bereavementRevenueCode as string)
        : BEREAVEMENT_REVENUE_CODE;
    const defects: string[] = [];

    // Discharge-bearing TOBs require both a discharge reason and a discharge date.
    if (DISCHARGE_TOBS.includes(c.tob)) {
      if (c.dischargeDate === null) defects.push("discharge claim has no discharge date");
      if (c.dischargeReason === null || c.dischargeReason.trim() === "") {
        defects.push("discharge claim has no discharge reason");
      }
    }

    // Bereavement lines (0942) are non-covered: they must not carry a billable charge.
    for (const line of ctx.lines) {
      if (line.revenueCode === bereavementCode && line.lineChargeCents > 0) {
        defects.push(`${line.serviceDate}: bereavement line (0942) carries a billable charge`);
      }
    }

    if (defects.length === 0) {
      return pass(
        KEY,
        "error",
        "Discharge facts complete and no improperly-billed bereavement service.",
      );
    }
    return fail(
      KEY,
      "error",
      `Discharge / bereavement legitimacy has ${defects.length} defect(s).`,
      {
        summary: "Record the discharge reason/date or remove the non-covered bereavement charge.",
        blameTarget: "claim",
        blameTargetId: c.claimId,
        fixAction: "edit_claim",
      },
      { defectCount: defects.length, firstDefect: defects[0] ?? "" },
    );
  },
};
