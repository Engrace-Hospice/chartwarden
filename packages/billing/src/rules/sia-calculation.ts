// @wardenx/billing — §4.5 rule `sia_calculation_correct` (sia, error, regulatory). The Service Intensity
// Add-on (SIA), when present, must reflect qualifying RN / MSW visits in the last 7 days of life per the
// CMS rule, and must not be double-counted with another adjustment (D6). This rule verifies the SIA
// snapshot against the signed-encounter window the service layer materialized. PURE: reads ctx only.
import type { Rule } from "./types";
import { fail, pass, skip } from "./types";

const KEY = "sia_calculation_correct";

/** SIA qualifying disciplines: registered-nurse and medical-social-worker visits (CMS SIA rule). */
const SIA_DISCIPLINES: readonly string[] = ["RN", "MSW"];

export const siaCalculationCorrect: Rule = {
  key: KEY,
  version: 1,
  category: "sia",
  title: "Service Intensity Add-on calculated correctly",
  description:
    "When an SIA is present it must reflect qualifying RN/MSW visits in the last 7 days of life and must " +
    "not be double-counted with another adjustment (D6 / CMS SIA rule).",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  defaultParameters: { qualifyingDisciplines: SIA_DISCIPLINES },
  check: (ctx) => {
    if (ctx.sia === null || !ctx.sia.present) {
      // No SIA on this claim (patient not in last-7-days-of-life window, or no qualifying visit).
      return skip(KEY, "error", "not_applicable", "No SIA add-on present on this claim.");
    }
    const sia = ctx.sia;
    const defects: string[] = [];

    if (sia.doubleCounted) {
      defects.push("SIA is double-counted with another adjustment");
    }
    // The claimed qualifying-visit count must be backed by signed RN/MSW encounters in the window.
    const backingVisits = ctx.signedEncounters.filter(
      (e) => e.signed && SIA_DISCIPLINES.includes(e.discipline),
    ).length;
    if (sia.qualifyingVisitCount <= 0) {
      defects.push("SIA present but claims zero qualifying visits");
    }
    if (sia.qualifyingVisitCount > backingVisits) {
      defects.push(
        `SIA claims ${sia.qualifyingVisitCount} visit(s) but only ${backingVisits} signed RN/MSW visit(s) back it`,
      );
    }

    // TODO(CMS-fixture): the per-15-minute SIA payment amount (RHC per-diem hourly rate × qualifying
    // minutes, capped at 4 hours/day) requires the CMS-published SIA hourly-rate file + a worked example
    // we do not yet hold; this rule verifies the qualifying-visit + non-double-count invariants only.

    if (defects.length === 0) {
      return pass(
        KEY,
        "error",
        `SIA reflects ${sia.qualifyingVisitCount} qualifying visit(s), not double-counted.`,
      );
    }
    return fail(
      KEY,
      "error",
      `SIA calculation has ${defects.length} defect(s).`,
      {
        summary: "Re-derive the SIA from the last-7-days RN/MSW visits and clear any double-count.",
        blameTarget: "claim",
        blameTargetId: ctx.claim.claimId,
        fixAction: "recompute_sia",
      },
      {
        defectCount: defects.length,
        firstDefect: defects[0] ?? "",
        claimedVisits: sia.qualifyingVisitCount,
        backingVisits,
      },
    );
  },
};
