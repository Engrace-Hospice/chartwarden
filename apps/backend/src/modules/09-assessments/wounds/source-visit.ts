// apps/backend/src/modules/09-assessments/wounds/source-visit.ts — WF09: the visit a wound observation is tied to is not the caller's to claim.
//
// An observation may carry the `sourceEncounterId` of the visit note it was recorded in, a logical uuid (M9 reads no M8 table), and the note then
// states it. Without a check a clinician could tie an observation to someone else's note, to another patient's, or to a note already closed.
// M8's `EncounterDraftReader` seam answers who owns the visit; this file turns the answer into the refusal. It must run OUTSIDE any open
// transaction: the seam opens its own tenant context.
//
//   unknown visit / another patient's / another author's → 404 (one answer for all three: the check is not an existence oracle for a visit)
//   the caller's own visit, no longer a draft           → 409 ENCOUNTER_NOT_DRAFT
//   the caller's own open visit, whose note has no wounds section (a telephonic visit, a therapy or social-work note; M8 answers
//   `templateStatesWounds`) → 422 WOUND_NOT_IN_NOTE: the observation would be saved and then left out of the signed note without a word
import { WoundValidationError } from "@chartwarden/assessments";
import { ChartWardenError, type EncounterDraftReader, NotFoundError } from "@chartwarden/types";
import { getSeam } from "../../../bootstrap/index";

/** The production reader: M8's seam through the M1 registry, resolved per call so a late-wired seam is picked up; the deny-stub fails closed. */
export const seamEncounterDraftReader: EncounterDraftReader = {
  draftOf: (input) => getSeam("EncounterDraftReader").draftOf(input),
};

/** The reader a service with none wired uses: no visit exists, so nothing can be tied to one (fails closed). */
export const noEncounterDraftReader: EncounterDraftReader = { draftOf: async () => null };

/** Throws unless `encounterId` is the caller's own visit note, for `patientId`, still being written, in a note that states wounds. */
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
      `this visit note is already ${facts.status}: a wound observation can only be tied to a note while it is being written`,
      409,
    );
  }
  if (!facts.templateStatesWounds) {
    throw new WoundValidationError({
      code: "WOUND_NOT_IN_NOTE",
      message:
        "this visit's note has no skin and wounds section, so the observation would not appear in it: record it without tying it to the visit",
    });
  }
}
