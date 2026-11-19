// apps/backend/src/modules/08-encounters/drafting/amendment-part2.ts — who may amend a Part 2 section (S1 PR E2b; ADR-0114 VN-D30, VN-D13).
//
// An author without 42 CFR Part 2 disclosure drafts from sources that exclude the SUD content, so their confirmed redraft of a section whose
// LATEST signed version is Part 2 derived (the original row, or the latest signed amendment of it) would silently shorten the current view an
// entitled reader sees. Such an amendment is refused: 422 `AMENDMENT_PART2_NOT_ENTITLED` at naming and again at sign (the verdict can change
// between the two). The verdict is the draft's own (M7's per-actor decision, caller module m8, an M39 failure is a failure, never a denial); a
// check that cannot be decided is the caller's 503 and never a pass. The refusal says nothing of Part 2 and names no section: that a section
// is Part 2 is itself what a signer without disclosure is not told by an error (the note view shows only that a section is withheld).
import { EncounterStateError } from "../lifecycle/errors";

export interface AmendPart2Check {
  /** The named sections whose LATEST signed version is `part2_derived` (`part2SectionsAmong`); empty means there is nothing to ask. */
  readonly part2Sections: readonly string[];
  /** Whether this author may read the patient's Part 2 content (asked once, only when needed). */
  readonly entitled: () => Promise<boolean>;
  /** The 503 a verdict that could not be decided becomes (its code differs between naming and sign). */
  readonly unavailable: (cause: unknown) => EncounterStateError;
}

/** One sealed version of a section: just the facts the guard needs. */
export interface SectionVersionFlag {
  readonly sectionId: string;
  readonly part2Derived: boolean;
}

/**
 * The named sections whose LATEST signed version is Part 2 derived, in note order. `originals` are the rows of the note's own pin;
 * `amendments` the signed amendment rows OLDEST FIRST (the order their addenda were signed), so a later row of a section replaces an earlier
 * one and the original. A section whose original was not Part 2 but whose latest amendment is stays guarded; one whose Part 2 original was
 * replaced by an amendment that holds none is not.
 */
export function part2SectionsAmong(
  originals: readonly SectionVersionFlag[],
  amendments: readonly SectionVersionFlag[],
  named: readonly string[],
): readonly string[] {
  const latest = new Map([...originals, ...amendments].map((s) => [s.sectionId, s.part2Derived]));
  const wanted = new Set(named);
  return originals
    .filter((o) => wanted.has(o.sectionId) && latest.get(o.sectionId) === true)
    .map((o) => o.sectionId);
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
      "a named section cannot be amended by this signer",
    );
  }
}
