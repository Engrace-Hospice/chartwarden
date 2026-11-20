// apps/backend/src/modules/07-care-plan/change-proposals-visit.ts — WF09: the visit a change proposal is recorded in is not the caller's to claim.
//
// A proposal carries the `sourceEncounterId` of the visit note it came from, a logical uuid (M7 reads no M8 table). Without a check a clinician
// could bind a draft to someone else's visit (it would be released when THAT visit finalizes), to another patient's, or to a note already closed
// (a draft recorded after its visit's `finalized` event was consumed would stay a draft forever). M8's `EncounterDraftReader` seam answers who
// owns the visit; this file turns the answer into the refusal. It must run OUTSIDE any open transaction: the seam opens its own tenant context.
//
//   unknown visit / another patient's / another author's → 404 (one answer for all three: the check is not an existence oracle for a visit)
//   the caller's own visit, no longer a draft           → 409 ENCOUNTER_NOT_DRAFT (the clinician is told why, so nothing is silently stranded)
import {
  ChartWardenError,
  type EncounterDraftFacts,
  type EncounterDraftReader,
  NotFoundError,
} from "@chartwarden/types";
import { getSeam } from "../../bootstrap/index";

/** The production reader: M8's seam through the M1 registry, resolved per call so a late-wired seam is picked up; the deny-stub fails closed. */
export const seamEncounterDraftReader: EncounterDraftReader = {
  draftOf: (input) => getSeam("EncounterDraftReader").draftOf(input),
};

/** Throws unless `encounterId` is the caller's own visit note, for `patientId`, still being written. */
export async function assertOwnDraftVisit(
  visits: EncounterDraftReader,
  visit: {
    readonly organizationId: string;
    readonly encounterId: string;
    readonly patientId: string;
    readonly membershipId: string;
  },
): Promise<void> {
  const facts = await visits.draftOf({
    organizationId: visit.organizationId,
    encounterId: visit.encounterId,
  });
  if (
    !facts ||
    facts.patientId !== visit.patientId ||
    facts.authoredByMembershipId !== visit.membershipId
  ) {
    throw new NotFoundError("encounter", visit.encounterId);
  }
  if (facts.status !== "draft") {
    throw new ChartWardenError(
      "ENCOUNTER_NOT_DRAFT",
      `this visit note is already ${facts.status}: a plan change can only be recorded while the note is being written`,
      409,
    );
  }
}

/**
 * What a visit that is no longer a draft means for a draft recorded in it: the move the lifecycle consumers make (`m8.encounter.finalized` →
 * release, `m8.encounter.voided` → withdraw). `null` for a note still being written, or one M8 can no longer answer for (nothing to move to).
 */
export function settlementOf(
  status: EncounterDraftFacts["status"] | undefined,
): "release" | "withdraw" | null {
  if (status === undefined || status === "draft") return null;
  return status === "voided" ? "withdraw" : "release";
}
