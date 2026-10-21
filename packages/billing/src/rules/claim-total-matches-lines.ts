// @chartwarden/billing — §4.5 rule `claim_total_matches_lines` (charges, error, regulatory). The 837I claim-level
// charge (CLM02) must equal the sum of the service-line charges; Stedi (and payers) reject a claim that does
// not balance. The expected-payment add-ons (SIA) are paid by the MAC from the visit lines and are never part
// of the billed total, so a header that includes them cannot balance. PURE: reads ctx only.
import type { Rule } from "./types";
import { fail, pass } from "./types";

const KEY = "claim_total_matches_lines";

export const claimTotalMatchesLines: Rule = {
  key: KEY,
  version: 1,
  category: "charges",
  title: "Claim total equals the sum of line charges",
  description:
    "The claim's total charge must equal the sum of its service-line charges (837I CLM02 balances to SV2 " +
    "line charges). Payment add-ons the MAC derives from visit lines are not billed charges.",
  severity: "error",
  regulatoryRequired: true,
  overrideRoleRequired: "billing_manager",
  check: (ctx) => {
    const lineSumCents = ctx.lines.reduce((sum, line) => sum + line.lineChargeCents, 0);
    const claimTotalCents = ctx.claim.totalChargeCents;
    if (claimTotalCents === lineSumCents) {
      return pass(KEY, "error", "The claim total equals the sum of its line charges.");
    }
    return fail(
      KEY,
      "error",
      `The claim total (${claimTotalCents}c) does not equal the sum of its line charges (${lineSumCents}c).`,
      {
        summary:
          "Re-assemble the claim so the header total is the sum of its line charges; payment add-ons are not billed charges.",
        blameTarget: "claim",
        blameTargetId: ctx.claim.claimId,
        fixAction: "reassemble_claim",
      },
      { claimTotalCents, lineSumCents, differenceCents: claimTotalCents - lineSumCents },
    );
  },
};
