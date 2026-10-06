// @wardenx/billing — §4.5 rule `bereavement_discharge_legitimacy` (discharge, error, regulatory).
// Discharge claims must carry a discharge reason + date; bereavement-period lines (revenue code 0942)
// are restricted to allowable post-death services per the CMS rule (bereavement is a non-covered,
// non-reimbursable service — it must not appear as a billable charge). Reads the resolved claim
// discharge facts + line revenue codes. PURE: reads ctx only.
//
// v2 — also checks the discharge-driven claim codes (CMS Pub. 100-04 Ch. 11 §30.3; Transmittal 2410 /
// CR 7677): a claim whose patient status cannot be derived (death with no place of death recorded, a
// transfer with no receiving care setting, a discharge reason the manual does not code) is blocked, and so
// is a code set that would hit one of the CR 7677 return-to-provider edits.
import { dischargeCodeConflicts } from "../claim-codes";
import type { Rule } from "./types";
import { fail, pass } from "./types";

const KEY = "bereavement_discharge_legitimacy";

/** UB-04 revenue code for bereavement services (non-covered for Medicare hospice reimbursement). */
const BEREAVEMENT_REVENUE_CODE = "0942";

/** Discharge-bearing Types of Bill (admit-through-discharge and last-interim-before-discharge). */
const DISCHARGE_TOBS: readonly string[] = ["811", "814"];
/** Interim Types of Bill on which the patient is still a patient as of the Through date (status 30). */
const INTERIM_TOBS: readonly string[] = ["812", "813"];

const UNRESOLVED_MESSAGE = {
  place_of_death_missing:
    "death discharge has no place of death recorded (needed for patient status 40/41/42)",
  transfer_setting_missing:
    "transfer-out has no receiving care setting recorded (needed for patient status 50/51)",
  discharge_reason_not_codable:
    "discharge reason has no CMS claim coding; record the discharge under a specific reason",
} as const;

export const bereavementDischargeLegitimacy: Rule = {
  key: KEY,
  version: 2,
  category: "discharge",
  title: "Discharge / bereavement legitimacy",
  description:
    "Discharge claims must carry a discharge reason and date and a derivable patient status / condition / " +
    "occurrence code set (CMS Pub. 100-04 Ch. 11 §30.3); bereavement-period lines (revenue code 0942) are " +
    "non-covered and must not be billed as a reimbursable charge.",
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

    // Discharge claim codes (§30.3 / CR 7677) — every TOB carries a patient status (30 on interim bills).
    const codes = c.dischargeClaimCodes;
    if (codes.unresolved !== null) {
      defects.push(UNRESOLVED_MESSAGE[codes.unresolved]);
    } else {
      defects.push(...dischargeCodeConflicts(codes));
      const discharged = codes.patientStatus !== null && codes.patientStatus !== "30";
      if (DISCHARGE_TOBS.includes(c.tob) && !discharged) {
        defects.push(`discharge bill ${c.tob} carries patient status ${codes.patientStatus}`);
      }
      if (INTERIM_TOBS.includes(c.tob) && discharged) {
        defects.push(`interim bill ${c.tob} carries discharge patient status ${codes.patientStatus}`);
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
        summary:
          "Record the discharge reason/date, the place of death or the receiving care setting, or remove " +
          "the non-covered bereavement charge.",
        blameTarget: "claim",
        blameTargetId: c.claimId,
        fixAction: "edit_claim",
      },
      { defectCount: defects.length, firstDefect: defects[0] ?? "" },
    );
  },
};
