// apps/backend/src/modules/08-encounters/drafting/serial-seams.ts — the draft's seam reads, one at a time (S1; design §3.2 "Connections").
//
// Every seam read (M7 care plan, M9 scale series and wounds, M12 medication orders, M39 Part 2) opens its OWN pooled transaction (`withOrgContextFromRequest`)
// while the draft request already holds one, and on a write (section PUT, finalize, sign) holds the encounter row lock with it. The draft reads
// its four sources together, so one request could take six of the pool's ten connections (the request's, M7's two (it asks M39 inside), both M9
// series, M12's) and three such requests deadlock on the pool until its acquisition timeout turns them into DRAFT_UNAVAILABLE. Taking turns
// caps a request at its own connection plus one read, at the price of a few milliseconds per read.
import type { DraftSeamPorts } from "./ports";

const settled = (): void => undefined;

/**
 * The same seams, with at most one read in flight per call of this function (call it once per request). A read that fails or never answers
 * fails only itself (`guarded` bounds it, and the reads behind a hung one then fail on their own bound), and no result is cached.
 */
export function serialSeams(seams: DraftSeamPorts): DraftSeamPorts {
  let tail: Promise<void> = Promise.resolve();
  const inTurn =
    <A extends unknown[], R>(read: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      const turn = tail.then(() => read(...args));
      tail = turn.then(settled, settled);
      return turn;
    };
  return {
    carePlanAsOf: inTurn(seams.carePlanAsOf.bind(seams)),
    // S4: the social-work and chaplain draft's one source, M15's plan, takes its turn like the others (it opens its own pooled transaction).
    disciplinePlanAsOf: inTurn(seams.disciplinePlanAsOf.bind(seams)),
    // S5b: the IDG follow-up draft's one source, M14's open action items, takes its turn like the others (it opens its own pooled transaction, and M39 inside it).
    idgFollowUpItems: inTurn(seams.idgFollowUpItems.bind(seams)),
    linkedIdgFollowUpItem: inTurn(seams.linkedIdgFollowUpItem.bind(seams)),
    scaleSeries: inTurn(seams.scaleSeries.bind(seams)),
    medicationChangesBetween: inTurn(seams.medicationChangesBetween.bind(seams)),
    // S2: the four module-6 reads of a recertification draft take their turn too.
    electionPeriods: inTurn(seams.electionPeriods.bind(seams)),
    levelOfCareOn: inTurn(seams.levelOfCareOn.bind(seams)),
    attestedFaceToFace: inTurn(seams.attestedFaceToFace.bind(seams)),
    activeCertification: inTurn(seams.activeCertification.bind(seams)),
    // S2b: the admission visit's three reads (M12 orders, M5 roster, M39 acknowledgment) take their turn too.
    activeMedicationsAsOf: inTurn(seams.activeMedicationsAsOf.bind(seams)),
    caregiversOn: inTurn(seams.caregiversOn.bind(seams)),
    advanceDirectiveAcknowledgment: inTurn(seams.advanceDirectiveAcknowledgment.bind(seams)),
    recordedWounds: inTurn(seams.recordedWounds.bind(seams)),
    part2DisclosureAllowed: inTurn(seams.part2DisclosureAllowed.bind(seams)),
  };
}
