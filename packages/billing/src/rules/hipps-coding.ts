// @wardenx/billing — §4.5 rule `hipps_coding_correct` (hipps, error, regulatory). The claim's HIPPS code
// must derive correctly from the LOC-period segments and the wage-index factor, and the RHC days-1–7 vs.
// days-8+ payment split must be correct (D7). This rule verifies the STRUCTURAL invariants of the HIPPS
// snapshot the (separate) HIPPS calculator produced; the penny-exact rate-table conformance is gated on a
// CMS fixture we do not yet hold. PURE: reads ctx only.
import type { Rule } from "./types";
import { fail, pass, skip } from "./types";

const KEY = "hipps_coding_correct";

// HIPPS codes are 5 characters (CMS HIPPS rate-code structure).
const HIPPS_CODE_LENGTH = 5;

export const hippsCodingCorrect: Rule = {
  key: KEY,
  version: 1,
  category: "hipps",
  title: "HIPPS coding derives correctly",
  description:
    "The HIPPS code must derive from the claim's LOC-period segments and the applied wage-index factor, " +
    "with the RHC days-1–7 vs. days-8+ payment split correct (D7).",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  check: (ctx) => {
    if (ctx.hipps === null) {
      // The calculator has not run / no per-diem applies (e.g. a notice-only claim) — not applicable.
      return skip(KEY, "error", "not_applicable", "No HIPPS derivation present for this claim.");
    }
    const { hippsCode, segments, wageIndexFactorApplied } = ctx.hipps;
    const defects: string[] = [];

    if (hippsCode.length !== HIPPS_CODE_LENGTH) {
      defects.push(`HIPPS code '${hippsCode}' is not ${HIPPS_CODE_LENGTH} characters`);
    }
    if (segments.length === 0) {
      defects.push("no LOC-period segments backing the HIPPS derivation");
    }
    // The wage-index factor must have been applied as a decimal string (never a float; D11/D12).
    if (!/^\d+(\.\d+)?$/.test(wageIndexFactorApplied)) {
      defects.push(`wage-index factor '${wageIndexFactorApplied}' is not a decimal string`);
    }
    // RHC segments must carry a concrete days-1–7 / days-8+ bucket; non-RHC must be 'n/a'.
    for (const seg of segments) {
      const isRhc = seg.levelOfCare === "routine_home_care";
      if (isRhc && seg.rhcDayBucket === "n/a") {
        defects.push(`RHC segment ${seg.dateFrom}..${seg.dateTo} missing days-1–7/8+ bucket`);
      }
      if (!isRhc && seg.rhcDayBucket !== "n/a") {
        defects.push(`non-RHC segment ${seg.dateFrom}..${seg.dateTo} carries an RHC day bucket`);
      }
    }

    // TODO(CMS-fixture): byte-exact HIPPS rate-code conformance (the HIPPS code → per-diem base-rate
    // table and the wage-index labor/non-labor split) requires the CMS-published HIPPS rate file + a
    // worked example we do not yet hold; this rule verifies the structural derivation invariants only.

    if (defects.length === 0) {
      return pass(KEY, "error", "HIPPS code structure and RHC day-split are internally coherent.");
    }
    return fail(
      KEY,
      "error",
      `HIPPS derivation has ${defects.length} structural defect(s).`,
      {
        summary: "Re-run the HIPPS calculation; the derived code/segments are internally inconsistent.",
        blameTarget: "claim",
        blameTargetId: ctx.claim.claimId,
        fixAction: "recompute_hipps",
      },
      { defectCount: defects.length, firstDefect: defects[0] ?? "", hippsCode },
    );
  },
};
