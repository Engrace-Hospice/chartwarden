// apps/backend/src/modules/08-encounters/drafting/amendment-part2.ts — who may amend a note that holds Part 2 content (S1 PR E2b; ADR-0114
// VN-D30, VN-D13).
//
// An author without 42 CFR Part 2 disclosure drafts from sources that exclude the SUD content, so their confirmed redraft of a section of such a
// note would silently shorten the current view an entitled reader sees. When the note holds Part 2 content in ANY section at ANY version (its pin,
// an original row or a signed amendment row: `noteHasPart2Version`), a signer without disclosure may name no section of it at all: 422
// `AMENDMENT_PART2_NOT_ENTITLED` at naming and again at sign (the verdict can change between the two). The answer is the same whichever section is
// named, so it is no oracle for which sections hold Part 2 (answering "unknown section" for one would be the same oracle: template section ids are
// public). The verdict is the draft's own (M7's per-actor decision, caller module m8, an M39 failure is a failure, never a denial) and is asked
// only when the note holds Part 2 content; a check that cannot be decided is the caller's 503 and never a pass. The refusal's wording names no
// section and says nothing of Part 2; that the note holds Part 2 content is what the refusal itself tells a signer without disclosure, and the
// code is the client's key.
import { EncounterStateError } from "../lifecycle/errors";

export interface AmendPart2Check {
  /** The note holds Part 2 content in any section at any version (`noteHasPart2Version`); false means there is nothing to ask. */
  readonly noteHasPart2: boolean;
  /** Whether this author may read the patient's Part 2 content (asked once, only when needed). */
  readonly entitled: () => Promise<boolean>;
  /** The 503 a verdict that could not be decided becomes (its code differs between naming and sign). */
  readonly unavailable: (cause: unknown) => EncounterStateError;
}

export async function assertMayAmendPart2(check: AmendPart2Check): Promise<void> {
  if (!check.noteHasPart2) return;
  let entitled: boolean;
  try {
    entitled = await check.entitled();
  } catch (cause) {
    throw check.unavailable(cause);
  }
  if (!entitled) {
    throw new EncounterStateError(
      "AMENDMENT_PART2_NOT_ENTITLED",
      "this note cannot be amended by this signer",
    );
  }
}
