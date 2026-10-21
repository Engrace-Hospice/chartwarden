import { periodsOverlappingClaim } from "./_util";
// @chartwarden/billing — §4.5 rule `f2f_attested_for_recert` (f2f, error, regulatory). A face-to-face
// encounter attestation is required for the third and subsequent benefit periods (42 CFR §418.22(a)(4)).
// Reads the resolved `electionPeriods` + `faceToFace` snapshots; only periods with sequence ≥ 3 are in
// scope. PURE: reads ctx only.
//
// DEATH WITHIN 2 DAYS (MBPM ch. 9 §20.1(5)(d)): for a NEW admission in period 3+ admitted with DOCUMENTED
// exceptional circumstances (the M6 seam fact `f2fExceptionDocumented`), a patient who dies within 2 days of
// admission without a face-to-face has the encounter "deemed as complete" — that period passes.
import type { Rule } from "./types";
import { fail, pass } from "./types";

const KEY = "f2f_attested_for_recert";
/** MBPM ch. 9 §20.1(5)(d) — the post-admission grace (days) of the exceptional-circumstance path. */
const F2F_EXCEPTION_GRACE_DAYS = 2;
const MS_PER_DAY = 86_400_000;

/** Whole calendar days from `from` to `to` (ISO dates; negative when `to` precedes `from`). */
function daysFrom(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
}

/** §20.1(5)(d): documented exception + death on/within 2 days after the period start ⇒ F2F deemed complete. */
function deemedCompleteByDeath(
  period: { readonly effectiveFrom: string; readonly f2fExceptionDocumented?: boolean },
  deathDate: string | null | undefined,
): boolean {
  if (period.f2fExceptionDocumented !== true || !deathDate) return false;
  const d = daysFrom(period.effectiveFrom, deathDate);
  return d >= 0 && d <= F2F_EXCEPTION_GRACE_DAYS;
}

export const f2fAttestedForRecert: Rule = {
  key: KEY,
  version: 2,
  category: "f2f",
  title: "Face-to-face attested for recertification periods",
  description:
    "For the third and later benefit periods, a physician/NP face-to-face encounter attestation must be " +
    "on file before the period (42 CFR §418.22(a)(4)). A new admission with documented exceptional " +
    "circumstances whose patient dies within 2 days has it deemed complete (MBPM ch. 9 §20.1(5)(d)).",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "medical_director",
  defaultParameters: { minSequenceRequiringF2f: 3 },
  check: (ctx, params) => {
    const min =
      typeof params.minSequenceRequiringF2f === "number"
        ? (params.minSequenceRequiringF2f as number)
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
    let deemed = 0;
    for (const p of recertPeriods) {
      const f2f = ctx.faceToFace.find((f) => f.electionPeriodSequence === p.sequence);
      if (f2f?.attested) continue;
      if (deemedCompleteByDeath(p, ctx.claim.deathDate)) {
        deemed += 1;
        continue;
      }
      missing.push(p.sequence);
    }
    if (missing.length === 0) {
      return pass(
        KEY,
        "error",
        deemed > 0
          ? "Face-to-face attested, or deemed complete: death within 2 days of a documented-exception admission (MBPM ch. 9 §20.1(5)(d))."
          : "A face-to-face attestation exists for every recertification period.",
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
