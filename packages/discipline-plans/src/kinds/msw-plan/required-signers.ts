// @chartwarden/discipline-plans — §3.5 / D11 MSW Plan required-signer set (M15-T01).

import type { RequiredSignersByVersionKind } from "../aide-poc/required-signers";

/** §3.5 / D11 — MSW authors + signs; the RN Case Manager cosigns for IDG alignment (the RN is the case
 *  manager and carries the cross-discipline picture). */
export const MSW_PLAN_REQUIRED_SIGNERS: RequiredSignersByVersionKind = {
  initial: [
    { role: "msw", count: 1, isAcknowledgment: false },
    { role: "rn_case_manager", count: 1, isAcknowledgment: false },
  ],
  idg_review: [
    { role: "msw", count: 1, isAcknowledgment: false },
    { role: "rn_case_manager", count: 1, isAcknowledgment: false },
  ],
} as const;
