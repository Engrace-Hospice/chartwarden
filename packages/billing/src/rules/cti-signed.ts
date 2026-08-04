import { periodsOverlappingClaim } from "./_util";
// @wardenx/billing — §4.5 rule `cti_signed_per_period` (cert, error, regulatory). A signed Certification
// of Terminal Illness (CTI) must exist for every election period the claim's service window touches; for
// period 1 the attending physician's co-signature is required when the patient has an attending (42 CFR
// §418.22). Reads the resolved `electionPeriods` + `certifications` snapshots. PURE: reads ctx only.
import type { Rule } from "./types";
import { fail, pass } from "./types";

const KEY = "cti_signed_per_period";

export const ctiSignedPerPeriod: Rule = {
  key: KEY,
  version: 1,
  category: "cert",
  title: "CTI signed for every period in range",
  description:
    "A signed Certification of Terminal Illness must exist for each election period the claim covers; " +
    "period 1 also requires the attending physician's co-signature when an attending is on file " +
    "(42 CFR §418.22).",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "medical_director",
  check: (ctx) => {
    const periods = periodsOverlappingClaim(ctx.claim, ctx.electionPeriods);
    if (periods.length === 0) {
      return fail(
        KEY,
        "error",
        "No election period overlaps the claim window; cannot verify CTI.",
        {
          summary: "Correct the claim dates or election period (M6).",
          blameTarget: "election_period",
          fixAction: "edit_in_m6",
        },
      );
    }
    const unsigned: number[] = [];
    const missingCosign: number[] = [];
    for (const p of periods) {
      const cert = ctx.certifications.find((c) => c.electionPeriodSequence === p.sequence);
      if (cert === undefined || !cert.ctiSigned) {
        unsigned.push(p.sequence);
        continue;
      }
      if (cert.attendingCosignRequired && !cert.attendingCosigned) missingCosign.push(p.sequence);
    }
    if (unsigned.length === 0 && missingCosign.length === 0) {
      return pass(
        KEY,
        "error",
        "A signed CTI (with required co-signatures) exists for every period.",
      );
    }
    const parts: string[] = [];
    if (unsigned.length > 0) parts.push(`${unsigned.length} period(s) lack a signed CTI`);
    if (missingCosign.length > 0)
      parts.push(`${missingCosign.length} period(s) lack the attending co-sign`);
    return fail(
      KEY,
      "error",
      `Certification incomplete: ${parts.join("; ")}.`,
      {
        summary: "Obtain the missing CTI signatures / attending co-signature (M6) before billing.",
        blameTarget: "election_period",
        fixAction: "edit_in_m6",
      },
      {
        unsignedPeriodCount: unsigned.length,
        missingCosignPeriodCount: missingCosign.length,
        firstUnsignedPeriod: unsigned[0] ?? -1,
      },
    );
  },
};
