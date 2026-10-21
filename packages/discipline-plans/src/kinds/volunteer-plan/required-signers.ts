// @chartwarden/discipline-plans — §3.5 / D11 Volunteer Plan required-signer set (M15-T01).

import type { RequiredSignersByVersionKind } from "../aide-poc/required-signers";

/** §3.5 / D11 — the Volunteer Coordinator authors + signs (CoP 418.78(a) "qualified supervision"); the RN
 *  Case Manager cosigns for IDG alignment. */
export const VOLUNTEER_PLAN_REQUIRED_SIGNERS: RequiredSignersByVersionKind = {
  initial: [
    { role: "volunteer_coordinator", count: 1, isAcknowledgment: false },
    { role: "rn_case_manager", count: 1, isAcknowledgment: false },
  ],
  idg_review: [
    { role: "volunteer_coordinator", count: 1, isAcknowledgment: false },
    { role: "rn_case_manager", count: 1, isAcknowledgment: false },
  ],
} as const;
