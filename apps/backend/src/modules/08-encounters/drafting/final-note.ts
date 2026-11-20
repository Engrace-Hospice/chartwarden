// apps/backend/src/modules/08-encounters/drafting/final-note.ts — the text of a signed note, built from the confirmed draft and the
// clinician's own selections (S1 PR C2b2; VN-D7, design §3.2 "Sign"). Pure: no store, no clock, no cipher.
//
//   * `confirmed`  — the draft's text for the section: the drafted sentences and the clinician's own words, as the clinician saw them.
//   * `deselected` — the clinician's own selections and free text only; the drafted sentences stay out (VN-D8).
//   * not drafted  — the clinician's selections as Layer 1 renders them; a note whose sections are all like this is exactly what
//                    `assembleSelections` produces, so a tenant with nothing to draft sees no difference.
// A section that is unresolved or no longer matches its confirmation is refused (409 `DRAFT_SECTION_STALE`): the note is never built
// from content the clinician did not confirm.
import {
  type DraftSourceRef,
  assembleBlocks,
  joinBlocks,
  resolveSelectionTemplate,
} from "@chartwarden/hearthnote";
import type { ComputedDraft } from "./compute";
import { type SectionState, sectionsNeedResolving, unresolvedSections } from "./section-state";

/** One section of the signed note, in the order it is written. */
export interface FinalNoteSection {
  readonly sectionId: string;
  /** 0-based place among the sections the note carries (a section with no text is not carried). */
  readonly position: number;
  /** The section as written: its heading, a line break and its body. Joining the blocks by a blank line is the narrative. */
  readonly text: string;
  /** True when a confirmed drafted section may hold 42 CFR Part 2 content (fail closed). A clinician's own words are not classified. */
  readonly part2Derived: boolean;
  /** Ids and kinds of the records a confirmed drafted section was built from (VN-D7: audit-grade provenance, never text). */
  readonly sourceRefs: readonly DraftSourceRef[];
}

export interface FinalNote {
  readonly narrative: string;
  readonly sections: readonly FinalNoteSection[];
  /** True when any section of the note is Part 2 derived: what `hearthnote_assembled_output.part2_derived` records beside the pin. */
  readonly part2Derived: boolean;
}

export function finalNoteOf(computed: ComputedDraft, states: readonly SectionState[]): FinalNote {
  const unresolved = unresolvedSections(states);
  if (unresolved.length > 0) throw sectionsNeedResolving(unresolved);

  const confirmedIds = new Set(
    states.filter((s) => s.state === "confirmed").map((s) => s.sectionId),
  );
  const confirmed = computed.draft.sections.flatMap((section) =>
    section.state === "drafted" && confirmedIds.has(section.sectionId) ? [section] : [],
  );
  const bodies = Object.fromEntries(confirmed.map((section) => [section.sectionId, section.text]));
  const provenance = new Map(confirmed.map((section) => [section.sectionId, section]));

  const template = resolveSelectionTemplate(computed.selection);
  const blocks = assembleBlocks(template, computed.selection, computed.context, bodies);
  const sections = blocks.map((block, position) => ({
    sectionId: block.sectionId,
    position,
    text: block.text,
    part2Derived: provenance.get(block.sectionId)?.part2Derived ?? false,
    sourceRefs: provenance.get(block.sectionId)?.sourceRefs ?? [],
  }));
  return {
    narrative: joinBlocks(blocks),
    sections,
    part2Derived: sections.some((section) => section.part2Derived),
  };
}
