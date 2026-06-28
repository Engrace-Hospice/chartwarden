// @wardenx/billing — §4.5 rule `place_of_service_consistency` (pos, error, regulatory). Each line's
// Q-code must match the patient's documented place of service (home / ALF / SNF / IPU) per the M5/M40
// facility lookup; place-of-service changes must be documented with effective dates (M6). Reads the
// resolved `mdm.placeOfService` + line Q-codes; SKIPs when the M40 resolver is unbound. PURE: reads ctx.
import type { Rule } from "./types";
import { fail, pass, skip } from "./types";
import { paramStringMap } from "./_util";

const KEY = "place_of_service_consistency";

/**
 * CMS hospice Q-code → eligible place(s) of service (the §4.5 default mapping; tenant-overridable). The
 * Q-codes describe where hospice care is furnished:
 *   Q5001 patient home/residence · Q5002 assisted-living facility · Q5003 long-term-care / nursing
 *   facility (non-SNF) · Q5004 skilled-nursing facility · Q5005 inpatient hospital · Q5006 inpatient
 *   hospice facility · Q5007 long-term care hospital · Q5008 inpatient psychiatric · Q5009 place N.O.S.
 */
const POS_BY_QCODE: Readonly<Record<string, string>> = {
  Q5001: "home",
  Q5002: "alf",
  Q5003: "ltc",
  Q5004: "snf",
  Q5005: "hospital",
  Q5006: "ipu",
  Q5007: "ltch",
  Q5008: "psych",
  Q5009: "nos",
};

export const placeOfServiceConsistency: Rule = {
  key: KEY,
  version: 1,
  category: "pos",
  title: "Place-of-service / Q-code consistency",
  description:
    "Each line's Q-code must match the patient's documented place of service (home/ALF/SNF/IPU) per the " +
    "M5/M40 facility lookup; place-of-service changes must be documented with effective dates (M6).",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  defaultParameters: { placeByQCode: POS_BY_QCODE },
  check: (ctx, params) => {
    if (!ctx.seams.mdmResolverBound) {
      return skip(KEY, "error", "seam_not_bound", "MDM/facility resolver (M40) not bound — POS check deferred.");
    }
    const documentedPos = ctx.mdm.placeOfService;
    if (documentedPos === null) {
      return fail(KEY, "error", "The patient's documented place of service is unknown.", {
        summary: "Record the patient's place of service (M5/M6) before billing.",
        blameTarget: "patient",
        blameTargetId: ctx.claim.patientId,
        fixAction: "edit_in_m6",
      });
    }
    const placeByQCode = paramStringMap(params, "placeByQCode", POS_BY_QCODE);
    const mismatches: string[] = [];
    for (const line of ctx.lines) {
      if (line.qCode === null) continue; // not every line carries a site-of-service Q-code
      const expectedPos = placeByQCode[line.qCode];
      if (expectedPos === undefined) {
        mismatches.push(`${line.serviceDate}: unknown Q-code ${line.qCode}`);
      } else if (expectedPos !== documentedPos) {
        mismatches.push(`${line.serviceDate}: Q-code ${line.qCode} (${expectedPos}) ≠ documented ${documentedPos}`);
      }
    }
    if (mismatches.length === 0) {
      return pass(KEY, "error", `Every line's Q-code matches the documented place of service (${documentedPos}).`);
    }
    return fail(
      KEY,
      "error",
      `${mismatches.length} line(s) have a Q-code / place-of-service mismatch.`,
      {
        summary: "Correct the line Q-code or document the place-of-service change with effective dates (M6).",
        blameTarget: "claim_line",
        fixAction: "edit_in_m6",
      },
      { mismatchCount: mismatches.length, firstMismatch: mismatches[0] ?? "", documentedPos },
    );
  },
};
