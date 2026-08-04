import { periodsOverlappingClaim } from "./_util";
// @wardenx/billing — §4.5 rule `f2f_attested_for_recert` (f2f, error, regulatory). A face-to-face
// encounter attestation is required for the third and subsequent benefit periods (42 CFR §418.22(a)(4)).
// Reads the resolved `electionPeriods` + `faceToFace` snapshots; only periods with sequence ≥ 3 are in
// scope. PURE: reads ctx only.
import type { Rule } from "./types";
import { fail, pass } from "./types";

const KEY = "f2f_attested_for_recert";

export const f2fAttestedForRecert: Rule = {
  key: KEY,
  version: 1,
  category: "f2f",
  title: "Face-to-face attested for recertification periods",
  description:
    "For the third and later benefit periods, a physician/NP face-to-face encounter attestation must be " +
    "on file before the period (42 CFR §418.22(a)(4)).",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "medical_director",
  defaultParameters: { minSequenceRequiringF2f: 3 },
  check: (ctx, params) => {
    const min =
      typeof params["minSequenceRequiringF2f"] === "number"
        ? (params["minSequenceRequiringF2f"] as number)
        : 3;
    const recertPeriods = periodsOverlappingClaim(ctx.claim, ctx.electionPeriods).filter(
      (p) => p.sequence >= min,
    );
    if (recertPeriods.length === 0) {
      return pass(
        KEY,
        "error",
        "No recertification period (≥ 3) in range — face-to-face not required.",
      );
    }
    const missing: number[] = [];
    for (const p of recertPeriods) {
      const f2f = ctx.faceToFace.find((f) => f.electionPeriodSequence === p.sequence);
      if (f2f === undefined || !f2f.attested) missing.push(p.sequence);
    }
    if (missing.length === 0) {
      return pass(
        KEY,
        "error",
        "A face-to-face attestation exists for every recertification period.",
      );
    }
    return fail(
      KEY,
      "error",
      `${missing.length} recertification period(s) lack a face-to-face attestation.`,
      {
        summary:
          "Record the face-to-face encounter attestation (M6) for the recertification period(s).",
        blameTarget: "election_period",
        fixAction: "edit_in_m6",
      },
      { missingPeriodCount: missing.length, firstMissingPeriod: missing[0] ?? -1 },
    );
  },
};
