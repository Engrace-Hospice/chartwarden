// packages/narrative-vocab/src/index.ts — M8-T05 (spec §2.6, architecture §10.5.2).
//
// Public surface of the bounded clinical vocabulary: the entry/axis types, the curated corpus + its
// pinned version, and the pure lookup helpers the HearthNote assembly engine (and M14's IDG aggregator)
// resolve against. No assembly logic and no IO live here — this is the read-only reference library.
import type { EncounterDiscipline, EncounterType } from "@chartwarden/types";
import type { VocabEntry } from "./types";
import { VOCABULARY } from "./vocabulary";

export { DRAFT_VOCAB_CODES } from "./draft-entries";

export type { SlotSpec, VocabBodySystem, VocabCategory, VocabEntry } from "./types";
export {
  CORPUS_CLINICAL_REVIEW,
  FALL_FOLLOWUP_CODE,
  VOCABULARY,
  VOCAB_VERSION,
  type ClinicalReviewStatus,
} from "./vocabulary";
export {
  MAX_TEXT_SLOT_LENGTH,
  entrySlots,
  validateSelectionTree,
  type SelectionIssue,
  type SelectionIssueCode,
  type SelectionTreeInput,
} from "./slots";
export {
  NARRATIVE_VOCAB_RELEASES,
  UnregisteredNarrativeVocabRelease,
  activeNarrativeVocabRelease,
  narrativeVocabReleaseById,
  type NarrativeVocabRelease,
} from "./releases";

/** Code → entry index for O(1) resolution at assembly time (built once, frozen). */
export const VOCAB_BY_CODE: ReadonlyMap<string, VocabEntry> = new Map(
  VOCABULARY.map((e) => [e.code, e]),
);

/** Resolve a single entry by its curated code, or `undefined` if it is not in the corpus. */
export function getVocabEntry(code: string): VocabEntry | undefined {
  return VOCAB_BY_CODE.get(code);
}

/** Whether `code` exists in the shipped corpus (the assembly engine's selection guard). */
export function hasVocabEntry(code: string): boolean {
  return VOCAB_BY_CODE.has(code);
}

/**
 * The entries a `(encounterType, discipline)` menu surfaces — i.e. the entries tagged for BOTH the
 * encounter type and the discipline. Returned in corpus order (stable), so the selection UI and the
 * template engine see the same deterministic ordering.
 */
export function entriesFor(
  encounterType: EncounterType,
  discipline: EncounterDiscipline,
): readonly VocabEntry[] {
  return VOCABULARY.filter(
    (e) => e.encounterTypes.includes(encounterType) && e.disciplines.includes(discipline),
  );
}
