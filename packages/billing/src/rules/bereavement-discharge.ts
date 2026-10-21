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
//
// v3 — every defect is also emitted as a structured `annotations.defects[]` entry with a stable code
// (`PLACE_OF_DEATH_MISSING`, `RECEIVING_CARE_SETTING_MISSING`, ...) and the record ids the fix needs; a missing
// place of death / receiving care setting points the remediation at the admission's guided "Fix discharge
// details" screen. The message, `observed.defectCount` and `observed.firstDefect` are unchanged.
import { dischargeCodeConflicts } from "../claim-codes";
import type { Rule, RuleDefect } from "./types";
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

/**
 * The structured defect codes this rule emits (`annotations.defects[].code`). Additive since v2: the existing
 * `message` / `observed.firstDefect` / `observed.defectCount` stay as they were, so earlier consumers are unaffected.
 */
export const DISCHARGE_DEFECT_CODES = {
  place_of_death_missing: "PLACE_OF_DEATH_MISSING",
  transfer_setting_missing: "RECEIVING_CARE_SETTING_MISSING",
  discharge_reason_not_codable: "DISCHARGE_REASON_NOT_CODABLE",
  dischargeDateMissing: "DISCHARGE_DATE_MISSING",
  dischargeReasonMissing: "DISCHARGE_REASON_MISSING",
  codeConflict: "DISCHARGE_CODE_CONFLICT",
  statusTobMismatch: "PATIENT_STATUS_TOB_MISMATCH",
  bereavementLineBilled: "BEREAVEMENT_LINE_BILLED",
} as const;

/** The two defects a biller resolves by completing the M6 discharge record (the guided "Fix discharge details"). */
const MISSING_DETAIL_SUMMARY = {
  place_of_death_missing:
    "CMS requires the patient status on the final claim. This death was recorded before ChartWarden captured the " +
    "place of death, so the status (40 home, 41 facility, 42 unknown) cannot be set. Record where the patient " +
    "died, then re-validate.",
  transfer_setting_missing:
    "CMS requires the patient status on the final claim. This transfer was recorded before ChartWarden captured " +
    "where the receiving hospice cares for the patient, so the status (50 home, 51 facility) cannot be set. " +
    "Record the receiving care setting, then re-validate.",
} as const;

export const bereavementDischargeLegitimacy: Rule = {
  key: KEY,
  version: 3,
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
    const defects: RuleDefect[] = [];
    const add = (code: string, message: string, refs?: Record<string, string>) =>
      defects.push({ code, message, ...(refs ? { refs } : {}) });

    // Discharge-bearing TOBs require both a discharge reason and a discharge date.
    if (DISCHARGE_TOBS.includes(c.tob)) {
      if (c.dischargeDate === null) {
        add(DISCHARGE_DEFECT_CODES.dischargeDateMissing, "discharge claim has no discharge date");
      }
      if (c.dischargeReason === null || c.dischargeReason.trim() === "") {
        add(
          DISCHARGE_DEFECT_CODES.dischargeReasonMissing,
          "discharge claim has no discharge reason",
        );
      }
    }

    // Discharge claim codes (§30.3 / CR 7677) — every TOB carries a patient status (30 on interim bills).
    const codes = c.dischargeClaimCodes;
    const sourceId = c.dischargeSourceEventId ?? null;
    if (codes.unresolved !== null) {
      const refs: Record<string, string> = { admissionId: c.admissionId, claimId: c.claimId };
      if (sourceId !== null && codes.unresolved === "place_of_death_missing") {
        refs.dischargeEventId = sourceId;
      }
      if (sourceId !== null && codes.unresolved === "transfer_setting_missing") {
        refs.transferEventId = sourceId;
      }
      add(DISCHARGE_DEFECT_CODES[codes.unresolved], UNRESOLVED_MESSAGE[codes.unresolved], refs);
    } else {
      for (const conflict of dischargeCodeConflicts(codes)) {
        add(DISCHARGE_DEFECT_CODES.codeConflict, conflict);
      }
      const discharged = codes.patientStatus !== null && codes.patientStatus !== "30";
      if (DISCHARGE_TOBS.includes(c.tob) && !discharged) {
        add(
          DISCHARGE_DEFECT_CODES.statusTobMismatch,
          `discharge bill ${c.tob} carries patient status ${codes.patientStatus}`,
        );
      }
      if (INTERIM_TOBS.includes(c.tob) && discharged) {
        add(
          DISCHARGE_DEFECT_CODES.statusTobMismatch,
          `interim bill ${c.tob} carries discharge patient status ${codes.patientStatus}`,
        );
      }
    }

    // Bereavement lines (0942) are non-covered: they must not carry a billable charge.
    for (const line of ctx.lines) {
      if (line.revenueCode === bereavementCode && line.lineChargeCents > 0) {
        add(
          DISCHARGE_DEFECT_CODES.bereavementLineBilled,
          `${line.serviceDate}: bereavement line (0942) carries a billable charge`,
        );
      }
    }

    if (defects.length === 0) {
      return pass(
        KEY,
        "error",
        "Discharge facts complete and no improperly-billed bereavement service.",
      );
    }
    // A missing place of death / receiving care setting is fixed on the M6 discharge record, not on the claim:
    // point the worklist's remediation link at the guided "Fix discharge details" screen for the admission.
    const missing =
      codes.unresolved === "place_of_death_missing" ||
      codes.unresolved === "transfer_setting_missing"
        ? codes.unresolved
        : null;
    const remediation = missing
      ? {
          summary: MISSING_DETAIL_SUMMARY[missing],
          blameTarget: "admission" as const,
          blameTargetId: c.admissionId,
          fixAction: "fix_discharge_details",
          fixDeepLink: `/admissions/${c.admissionId}/discharge-details?claimId=${c.claimId}`,
        }
      : {
          summary:
            "Record the discharge reason/date, the place of death or the receiving care setting, or remove " +
            "the non-covered bereavement charge.",
          blameTarget: "claim" as const,
          blameTargetId: c.claimId,
          fixAction: "edit_claim",
        };
    const failed = fail(
      KEY,
      "error",
      `Discharge / bereavement legitimacy has ${defects.length} defect(s).`,
      remediation,
      {
        defectCount: defects.length,
        firstDefect: defects[0]?.message ?? "",
        defectCodes: defects.map((d) => d.code).join(","),
      },
    );
    return { ...failed, annotations: { ...failed.annotations, defects } };
  },
};
