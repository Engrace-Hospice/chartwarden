// apps/backend/src/modules/23-billing-medicare/services/prior-election-closure.ts — is an earlier election closed out
// with Medicare? A re-election's NOE (8xA) is REJECTED while the prior election has no revocation / discharge date on
// the CWF, i.e. until the previous stay's NOTR (8xB) or its final claim has been filed (Claims Processing Manual
// ch. 11 §20.1.6). Read over M23's OWN tables only:
//
//   NOTR filed         a notr_record of the admission that left our hands (SUBMITTED / ACK_PENDING / ACK_ACCEPTED)
//   final claim filed  a claim of the admission with a discharge type of bill (811 admit-through-discharge, 814 final)
//                      that left our hands (submitted, acknowledged, paid / denied — not draft, rejected, voided,
//                      replaced)
//
// Two consumers: M23's own NOE-submit guard (`submitNoe`) and, through an injected port bound at the composition root,
// M6's readmission context (M6 may not import M23).
import type { BillingDb } from "@wardenx/billing";
import * as schema from "@wardenx/db/schema";
import { withOrgContext } from "@wardenx/tenancy";
import { ChartWardenError } from "@wardenx/types";
import { and, eq, inArray } from "drizzle-orm";

const NOTR = schema.notrRecord;
const CLAIM = schema.claim;

/** NOTR states that mean the notice was sent to the MAC. */
export const NOTR_FILED_STATES = ["SUBMITTED", "ACK_PENDING", "ACK_ACCEPTED"] as const;
/** The discharge types of bill (Claims Processing Manual ch. 11 §30.3: 8x1 admit-through-discharge, 8x4 final). */
export const FINAL_CLAIM_TOBS = ["811", "814"] as const;
/** Claim states that mean the claim was sent to the MAC (and was not withdrawn / rejected). */
export const FINAL_CLAIM_FILED_STATES = [
  "SUBMITTED",
  "ACK_PENDING",
  "ACK_ACCEPTED",
  "ACK_PARTIAL",
  "PAID",
  "PARTIAL_PAID",
  "DENIED",
] as const;

export interface PriorElectionClosure {
  readonly notrFiled: boolean;
  readonly finalClaimFiled: boolean;
}

/** Over the caller's RLS-scoped transaction. */
export async function priorElectionClosureTx(
  tx: BillingDb,
  q: { readonly admissionId: string; readonly patientId: string },
): Promise<PriorElectionClosure> {
  const [notr] = await tx
    .select({ id: NOTR.id })
    .from(NOTR)
    .where(and(eq(NOTR.admissionId, q.admissionId), inArray(NOTR.state, [...NOTR_FILED_STATES])))
    .limit(1);
  const [finalClaim] = await tx
    .select({ id: CLAIM.id })
    .from(CLAIM)
    .where(
      and(
        eq(CLAIM.patientId, q.patientId), // claim_patient_idx
        eq(CLAIM.admissionId, q.admissionId),
        inArray(CLAIM.tob, [...FINAL_CLAIM_TOBS]),
        inArray(CLAIM.state, [...FINAL_CLAIM_FILED_STATES]),
      ),
    )
    .limit(1);
  return { notrFiled: !!notr, finalClaimFiled: !!finalClaim };
}

/** Org-explicit (the M6 readmission-context port; no request transaction to join). */
export async function priorElectionClosureForOrg(
  db: BillingDb,
  organizationId: string,
  q: { readonly admissionId: string; readonly patientId: string },
): Promise<PriorElectionClosure> {
  return withOrgContext<BillingDb, PriorElectionClosure>(db, { organizationId, userId: "" }, (tx) =>
    priorElectionClosureTx(tx, q),
  );
}

/**
 * The patient's latest earlier stay that ended alive (live discharge, revocation, transfer-out) — an M6 fact, bound
 * at the composition root. `null` = no such stay (a first election: nothing to close out).
 */
export interface PriorLiveEndedStayPort {
  latestPriorLiveEndedAdmission(
    organizationId: string,
    q: { readonly patientId: string; readonly currentAdmissionId: string },
  ): Promise<{ readonly admissionId: string } | null>;
}

/** 409 PRIOR_ELECTION_NOT_CLOSED — the readmission's NOE would be rejected by Medicare. */
export class PriorElectionNotClosedError extends ChartWardenError {
  constructor(priorAdmissionId: string) {
    super(
      "PRIOR_ELECTION_NOT_CLOSED",
      "Medicare rejects a new Notice of Election while the patient's previous election is open: file the previous " +
        "stay's Notice of Termination/Revocation (8xB) or its final claim first",
      409,
      [{ field: "priorAdmissionId", code: "PRIOR_ELECTION_NOT_CLOSED", message: priorAdmissionId }],
    );
  }
}
