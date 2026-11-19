// apps/backend/src/modules/08-encounters/drafting/amendment-part2.ts — who may amend a Part 2 section (S1 PR E2b; ADR-0114 VN-D30, VN-D13).
//
// An author without 42 CFR Part 2 disclosure drafts from sources that exclude the SUD content, so their confirmed redraft of a section whose
// ORIGINAL is Part 2 derived would silently shorten the current view. Such an amendment is refused: 422 `AMENDMENT_PART2_NOT_ENTITLED` at naming and
// again at sign (the verdict can change between the two). The verdict is the draft's own (M7's per-actor decision, caller module m8, an M39 failure
// is a failure, never a denial); a check that cannot be decided is the caller's 503 and never a pass. Nothing about a section (its id, its text) is
// in the refusal: that a section is Part 2 is itself what the viewer is not entitled to.
import { EncounterStateError } from "../lifecycle/errors";

export interface AmendPart2Check {
  /** The named sections whose ORIGINAL sealed row is `part2_derived`; empty means there is nothing to ask. */
  readonly part2Sections: readonly string[];
  /** Whether this author may read the patient's Part 2 content (asked once, only when needed). */
  readonly entitled: () => Promise<boolean>;
  /** The 503 a verdict that could not be decided becomes (its code differs between naming and sign). */
  readonly unavailable: (cause: unknown) => EncounterStateError;
}

export async function assertMayAmendPart2(check: AmendPart2Check): Promise<void> {
  if (check.part2Sections.length === 0) return;
  let entitled: boolean;
  try {
    entitled = await check.entitled();
  } catch (cause) {
    throw check.unavailable(cause);
  }
  if (!entitled) {
    throw new EncounterStateError(
      "AMENDMENT_PART2_NOT_ENTITLED",
      "a section of this note holds information protected by 42 CFR Part 2 that your access does not include, so you cannot amend it",
    );
  }
}
