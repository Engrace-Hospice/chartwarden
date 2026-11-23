// apps/backend/src/modules/08-encounters/drafting/amendment-note.ts — the sections an addendum amends, as its sign sees them (S1 PR E2; VN-D30,
// VN-D12, design 3.1 "Amendment"). Pure: no store, no clock, no cipher.
//
// An amending addendum runs through the SAME draft pipeline as a note (`readNoteDraft`: recomputed for the author, as of the visit time, bound to
// a content hash and the corpus version), against the addendum's own resolutions instead of the note's. Only the sections the addendum NAMES count:
//   * `confirmed`                       — amended: the confirmed draft text becomes a sealed amendment row.
//   * `deselected`, `not_drafted`       — not amended: the author declined the redraft, or nothing is drafted to amend. The section stays as signed.
//   * `unresolved`, `needs_reconfirmation` — block the sign, exactly as for a note (DRAFT_SECTION_UNRESOLVED / DRAFT_SECTION_STALE).
// A sealed amendment is written only from a confirmed section: never from the clinician's own words, which the draft does not classify.
import type { DraftSourceRef } from "@chartwarden/hearthnote";
import { assembleBlocks, resolveSelectionTemplate } from "@chartwarden/hearthnote";
import type { NoteDraft } from "./note-draft";

/** One section a signed addendum amended: its block as the note carries a section, and what the sealed row records. */
export interface AmendedSection {
  readonly sectionId: string;
  /** The section as written: its heading, a line break and its body (the same block the original row seals). */
  readonly text: string;
  /** The compiler's fail-closed Part 2 verdict on the confirmed section. */
  readonly part2Derived: boolean;
  /** Ids and kinds of the records the section was built from (VN-D7: audit-grade provenance, never text). */
  readonly sourceRefs: readonly DraftSourceRef[];
}

/**
 * `draft` seen through the sections the addendum names: other sections' states are not its business. Template order. The actions are the draft's own, kept
 * for the named sections: those a section's state alone gives (unresolved, needs reconfirmation) and those `readNoteDraft` adds beyond the states (S5b: a
 * confirmed `idg_followup` section that a recompute no longer drafts, which would otherwise be amended by nothing, silently).
 */
export function restrictToNamed(draft: NoteDraft, named: readonly string[]): NoteDraft {
  const wanted = new Set(named);
  const states = draft.states.filter((state) => wanted.has(state.sectionId));
  return {
    computed: draft.computed,
    states,
    actions: draft.actions.filter((action) => wanted.has(action.sectionId)),
  };
}

/** The confirmed named sections of a restricted draft, in template order, built exactly as the signed note builds a confirmed section. */
export function amendedSectionsOf(draft: NoteDraft): readonly AmendedSection[] {
  const confirmed = new Set(
    draft.states.filter((state) => state.state === "confirmed").map((state) => state.sectionId),
  );
  const sections = draft.computed.draft.sections.flatMap((section) =>
    section.state === "drafted" && confirmed.has(section.sectionId) ? [section] : [],
  );
  if (sections.length === 0) return [];
  const bodies = Object.fromEntries(sections.map((section) => [section.sectionId, section.text]));
  const provenance = new Map(sections.map((section) => [section.sectionId, section]));
  const { selection, context } = draft.computed;
  return assembleBlocks(resolveSelectionTemplate(selection), selection, context, bodies).flatMap(
    (block): AmendedSection[] => {
      const source = provenance.get(block.sectionId);
      if (source === undefined) return [];
      return [
        {
          sectionId: block.sectionId,
          text: block.text,
          part2Derived: source.part2Derived,
          sourceRefs: source.sourceRefs.map((ref) => ({ kind: ref.kind, id: ref.id })),
        },
      ];
    },
  );
}
