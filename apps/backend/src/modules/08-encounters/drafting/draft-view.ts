// apps/backend/src/modules/08-encounters/drafting/draft-view.ts — the wire shape of a visit-note draft (S1 PR C2b1; VN-D5, VN-D7, VN-D13).
//
// VN-D7: a section's SOURCE IDS are kept in the audit trail only, so they are not here; `origins` names the KINDS of record a section was
// built from (VN-D5 "each shown with its origin"), never an id. `part2Derived` is the compiler's fail-closed flag (VN-D13): the text of
// a section is whatever the seams returned for THIS viewer, so another author's unredacted content never reaches it (VN-D10).
import type { DraftSection, DraftSourceKind } from "@chartwarden/hearthnote";
import type { DraftOverview } from "./compute";
import type { DraftEncounter } from "./ports";
import { type ConfirmationRecord, type SectionStateName, sectionStates } from "./section-state";

export interface DraftSectionView {
  readonly sectionId: string;
  readonly state: SectionStateName;
  /** The drafted text (source-derived sentences, then the clinician's own); `null` for a section with nothing to draft from. */
  readonly text: string | null;
  /** What a confirmation of this section binds to; `null` for an empty section. */
  readonly contentHash: string | null;
  readonly corpusVersion: string | null;
  /** Whether any source behind the section may be 42 CFR Part 2 content (fail closed); `null` for an empty section. */
  readonly part2Derived: boolean | null;
  /** The kinds of record the section was built from, in order, each once. */
  readonly origins: readonly DraftSourceKind[];
}

export interface DraftView {
  readonly encounterId: string;
  /** The touched patient, so the read is accountable against them (§164.528). */
  readonly patientId: string;
  readonly templateKey: string;
  /** The visit time the draft describes the patient at (ISO-8601, UTC). */
  readonly asOf: string;
  /** Every section of the template, in template order. */
  readonly sections: readonly DraftSectionView[];
}

export function sectionView(section: DraftSection, state: SectionStateName): DraftSectionView {
  if (section.state === "empty") {
    return {
      sectionId: section.sectionId,
      state,
      text: null,
      contentHash: null,
      corpusVersion: null,
      part2Derived: null,
      origins: [],
    };
  }
  return {
    sectionId: section.sectionId,
    state,
    text: section.text,
    contentHash: section.contentHash,
    corpusVersion: section.corpusVersion,
    part2Derived: section.part2Derived,
    origins: [...new Set(section.sourceRefs.map((ref) => ref.kind))],
  };
}

export function draftView(
  encounter: DraftEncounter,
  computed: DraftOverview,
  confirmations: readonly ConfirmationRecord[],
): DraftView {
  const states = new Map(
    sectionStates(computed.draft, confirmations).map((s) => [s.sectionId, s.state]),
  );
  return {
    encounterId: encounter.id,
    patientId: encounter.patientId,
    templateKey: computed.templateKey,
    asOf: computed.asOf,
    sections: computed.draft.sections.map((section) =>
      sectionView(section, states.get(section.sectionId) ?? "not_drafted"),
    ),
  };
}

/** The draft of a signed note as an AMENDING addendum's author sees it: only the sections the addendum names, in template order. */
export interface AmendmentDraftView extends DraftView {
  readonly addendumId: string;
}

export function amendmentDraftView(
  addendumId: string,
  sectionIds: readonly string[],
  view: DraftView,
): AmendmentDraftView {
  const named = new Set(sectionIds);
  return { ...view, addendumId, sections: view.sections.filter((s) => named.has(s.sectionId)) };
}
