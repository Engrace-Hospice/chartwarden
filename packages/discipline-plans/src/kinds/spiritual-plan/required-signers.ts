// @chartwarden/discipline-plans — §3.5 / D11 Spiritual Care Plan required-signer set (M15-T01).

import type { RequiredSignersByVersionKind } from "../aide-poc/required-signers";

/** §3.5 / D11 — chaplain self-sign. No RN cosignature: the chaplain's spiritual-care responsibility under
 *  CoP 418.64(d) is autonomous, and requiring nursing approval of spiritual content would over-model it. */
export const SPIRITUAL_PLAN_REQUIRED_SIGNERS: RequiredSignersByVersionKind = {
  initial: [{ role: "chaplain", count: 1, isAcknowledgment: false }],
  idg_review: [{ role: "chaplain", count: 1, isAcknowledgment: false }],
} as const;
