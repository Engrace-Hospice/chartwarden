// apps/backend/src/modules/23-billing-medicare/services/claim-sia-refresh.ts
//
// Keeps a claim's stored SIA snapshot and expected payment in step with the facts a re-validation just read. Both used
// to be written once at assembly and never again, so a clinician confirming a visit's delivery mode, a start/stop being
// documented or the CHC rate being re-keyed left the claim showing a stale add-on. `sia_calculation` is append-only, so a
// change is a NEW revision (appended only when the evaluation really moved); the expected payment is a derived
// projection (no version bump) re-derived through the same pipeline the assembly used.
import { type Cents, repositories } from "@chartwarden/billing";
import type { ClaimSia } from "./claim-assembly-facts";
import {
  sameSiaEvaluation,
  siaEndedSnapshotInput,
  siaSnapshotInputOf,
  siaStillPromised,
} from "./claim-sia-snapshot";
import type { BillingTx } from "./claim-state-service";

export interface SiaRefreshInputs {
  /** The evaluation this run's context was built from; `null` when no SIA applies to the claim any more. */
  readonly sia: ClaimSia | null;
  /** Per-diem total + SIA, net of sequestration — the same arithmetic as assembly. */
  readonly expectedPaymentCents: Cents;
}

/**
 * Append a SIA revision when (and only when) the evaluation moved, then re-derive the expected payment. A claim that
 * HAD a payable add-on and is now evaluated to none (a visit voided, a death record withdrawn) gets an explicit zero
 * revision, so the claim detail stops publishing units and dollars the expected payment no longer includes. The claim
 * row is locked first: two overlapping validations would otherwise both append and the second would die on the
 * `(claim_id, revision)` unique constraint.
 */
export async function refreshClaimSia(
  tx: BillingTx,
  claim: repositories.ClaimRecord,
  inputs: SiaRefreshInputs,
): Promise<void> {
  const siaRepo = new repositories.SiaCalculationRepository(tx);
  await siaRepo.lockClaimForRevision(claim.id);
  const stored = await siaRepo.findLatestSiaByClaim(claim.id);
  const ids = { orgId: claim.organizationId, claimId: claim.id };
  if (inputs.sia !== null) {
    const next = siaSnapshotInputOf(inputs.sia, ids);
    if (stored === null || !sameSiaEvaluation(stored, next)) await siaRepo.appendSiaRevision(next);
  } else if (stored !== null && siaStillPromised(stored)) {
    await siaRepo.appendSiaRevision(siaEndedSnapshotInput(stored, ids));
  }
  await new repositories.ClaimRepository(tx).refreshExpectedPayment(
    claim.id,
    inputs.expectedPaymentCents,
  );
}
