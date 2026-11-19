// apps/backend/src/modules/08-encounters/drafting/amendment-cosigner.ts — who must cosign a signed AMENDMENT (S1; ADR-0114 VN-D30). Moved out of the
// Drizzle service so it does not grow with every amendment rule; no behaviour of its own.
import { type DbClient, schema } from "@chartwarden/db";
import { eq } from "drizzle-orm";
import { EncounterStateError } from "../lifecycle/errors";

const COSIGN = schema.cosignatureRequests;

/** What the rule needs of the amended note. */
export interface AmendedNote {
  readonly id: string;
  readonly patientId: string;
  readonly authoredByMembershipId: string;
}

/** The RN the patient's care team routes a cosignature to, never one of `excludedMembershipIds` (M5's primary RN, `null` when there is none). */
export type EligibleCosigner = (
  patientId: string,
  excludedMembershipIds: readonly string[],
) => Promise<string | null>;

/**
 * The RN a signed AMENDMENT must be cosigned by, or `null` when its note never needed a cosigner (it has no cosignature request).
 * Refuses (422 NO_ELIGIBLE_COSIGNER, before any write) when the note needed one and there is none, or the signer is that RN, exactly as the note's
 * own sign does: an amendment nobody may cosign would leave the note's cosignature requirement unmet.
 */
export async function cosignerForAmendment(
  t: DbClient,
  parent: AmendedNote,
  signerMembershipId: string,
  eligibleCosigner: EligibleCosigner,
): Promise<string | null> {
  const [parentRequest] = await t
    .select({ id: COSIGN.id })
    .from(COSIGN)
    .where(eq(COSIGN.encounterId, parent.id))
    .limit(1);
  if (parentRequest === undefined) return null;
  // The signer AND the note's author are excluded: the cosign service refuses either at acknowledge and sign, so an amendment routed to the
  // note's author (the only RN on a small caseload, say) would be raised at someone who cannot act on it and stay pending for ever (C3).
  const cosigner = await eligibleCosigner(parent.patientId, [
    signerMembershipId,
    parent.authoredByMembershipId,
  ]);
  if (cosigner === null) {
    throw new EncounterStateError(
      "NO_ELIGIBLE_COSIGNER",
      "this note needed a cosignature, so its amendment does too, and no cosignature-eligible RN other than the signer and the note's author exists on the patient's caseload",
    );
  }
  return cosigner;
}
