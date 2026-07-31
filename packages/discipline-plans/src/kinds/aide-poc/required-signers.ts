// @wardenx/discipline-plans — §3.5 / D11 Aide POC required-signer set (M15-T01).

import type { DisciplineRequiredSignerSet, DisciplinePlanVersionKind } from "@wardenx/types";

/** The quorum for one plan kind, keyed by the version kind it applies to. `interim_revision` reuses the
 *  `initial` set; the auto-built `discharge` version is signed by the system actor and carries no quorum. */
export type RequiredSignersByVersionKind = {
  readonly [K in Extract<DisciplinePlanVersionKind, "initial" | "idg_review">]: DisciplineRequiredSignerSet;
};

/**
 * §3.5 / D11 — RN Case Manager authors + signs; the CHHA ACKNOWLEDGES. The acknowledgment is deliberately
 * not a cosignature: CoP 418.76 grants the supervising RN authorship of the aide's plan of care, and a
 * cosignature would imply an equal authorship the regulation does not give the aide.
 */
export const AIDE_POC_REQUIRED_SIGNERS: RequiredSignersByVersionKind = {
  initial: [
    { role: "rn_case_manager", count: 1, isAcknowledgment: false },
    { role: "chha_acknowledgment", count: 1, isAcknowledgment: true },
  ],
  idg_review: [
    { role: "rn_case_manager", count: 1, isAcknowledgment: false },
    { role: "chha_acknowledgment", count: 1, isAcknowledgment: true },
  ],
} as const;
