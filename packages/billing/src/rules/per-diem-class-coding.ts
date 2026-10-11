// @wardenx/billing — §4.5 rule `per_diem_class_coding_correct` (perDiemClass, error, regulatory). Verifies the
// STRUCTURAL invariants of the per-diem snapshot the calculator produced: segments present, the
// ADR-0001 RHC day-60 tier buckets (days_1_60 / days_61_plus) assigned, wage factor a decimal string.
// ADR-0001 NOTE (outstanding): the ADR strikes the HIPPS construct entirely (hospice claims carry no
// HIPPS rate code) and replaces this rule with an `rhc_rate_tier_coherence` rule; the snapshot's
// `per_diem_class_code` is an internal placeholder (surfaced as `perDiemClassCode`) never emitted on the 837 wire, and the full rename
// (`per_diem_rate_calculation` → per-diem naming, rule-key migration) is tracked in the ADR-compliance
// backlog. Penny-exact rate-table conformance is gated on a CMS fixture we do not yet hold. PURE.
import type { Rule } from "./types";
import { fail, pass, skip } from "./types";

const KEY = "per_diem_class_coding_correct";

// The internal per-diem class code is a fixed 5-character placeholder (`derivePerDiemClassCode`).
const PER_DIEM_CLASS_CODE_LENGTH = 5;

export const perDiemClassCodingCorrect: Rule = {
  key: KEY,
  version: 1,
  category: "perDiemClass",
  title: "Per-diem class coding derives correctly",
  description:
    "The per-diem snapshot must derive from the claim's LOC-period segments and the applied wage-index " +
    "factor, with the ADR-0001 RHC day-60 tier split (days 1–60 / 61+) structurally coherent (D7).",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  check: (ctx) => {
    if (ctx.perDiemClass === null) {
      // The calculator has not run / no per-diem applies (e.g. a notice-only claim) — not applicable.
      return skip(
        KEY,
        "error",
        "not_applicable",
        "No per-diem class derivation present for this claim.",
      );
    }
    const { perDiemClassCode, segments, wageIndexFactorApplied } = ctx.perDiemClass;
    const defects: string[] = [];

    if (perDiemClassCode.length !== PER_DIEM_CLASS_CODE_LENGTH) {
      defects.push(
        `per-diem class code '${perDiemClassCode}' is not ${PER_DIEM_CLASS_CODE_LENGTH} characters`,
      );
    }
    if (segments.length === 0) {
      defects.push("no LOC-period segments backing the per-diem class derivation");
    }
    // The wage-index factor must have been applied as a decimal string (never a float; D11/D12).
    if (!/^\d+(\.\d+)?$/.test(wageIndexFactorApplied)) {
      defects.push(`wage-index factor '${wageIndexFactorApplied}' is not a decimal string`);
    }
    // RHC segments must carry a concrete days-1–7 / days-8+ bucket; non-RHC must be 'n/a'.
    for (const seg of segments) {
      const isRhc = seg.levelOfCare === "routine_home_care";
      if (isRhc && seg.rhcDayBucket === "n/a") {
        defects.push(`RHC segment ${seg.dateFrom}..${seg.dateTo} missing its day-60 tier bucket`);
      }
      if (!isRhc && seg.rhcDayBucket !== "n/a") {
        defects.push(`non-RHC segment ${seg.dateFrom}..${seg.dateTo} carries an RHC day bucket`);
      }
    }

    // TODO(CMS-fixture): byte-exact HIPPS rate-code conformance (the per-diem class code → per-diem base-rate
    // table and the wage-index labor/non-labor split) requires the CMS-published HIPPS rate file + a
    // worked example we do not yet hold; this rule verifies the structural derivation invariants only.

    if (defects.length === 0) {
      return pass(
        KEY,
        "error",
        "Per-diem class code structure and RHC day-split are internally coherent.",
      );
    }
    return fail(
      KEY,
      "error",
      `per-diem class derivation has ${defects.length} structural defect(s).`,
      {
        summary:
          "Re-run the per-diem class calculation; the derived code/segments are internally inconsistent.",
        blameTarget: "claim",
        blameTargetId: ctx.claim.claimId,
        fixAction: "recompute_per_diem_class",
      },
      { defectCount: defects.length, firstDefect: defects[0] ?? "", perDiemClassCode },
    );
  },
};
