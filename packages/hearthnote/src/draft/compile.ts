// packages/hearthnote/src/draft/compile.ts — the pure visit-note draft compiler (S1 PR B, ADR-0114).
//
// `compileDraft(inputs, deps)` turns already-read records plus the clinician's selections into one entry per
// template section: a drafted section (text, source refs, Part 2 flag, content hash) or an explicit empty
// state. Deterministic by construction: no clock, no randomness, sources ordered by id, text normalized,
// and the hash taken over a canonical serialization (see `canonical.ts`). It never mutates its inputs.
import { VOCAB_VERSION } from "@chartwarden/narrative-vocab";
import {
  HearthnoteAssemblyError,
  renderSection,
  resolveSelectionTemplate,
} from "../assembly/assemble";
import { joinSentences } from "../assembly/grammar";
import { describeRecordedAdl } from "../assembly/recorded-findings";
import { describeRecordedBodyMeasures } from "../assembly/vitals";
import { templateKey } from "../templates/types";
import { canonicalJson, normalizeText } from "./canonical";
import { draftedSectionIds } from "./scope";
import { type SourceGroup, collectSourceGroups } from "./sources";
import type {
  Draft,
  DraftDeps,
  DraftInputs,
  DraftSection,
  DraftSourceRef,
  DraftedSection,
  EmptyDraftSection,
} from "./types";
import { DraftInputError, instantMs } from "./validate";

/** Written into every hashed payload; a change to the canonical rule needs a new value (see canonical.ts). */
const CONTENT_FORMAT = "hearthnote-draft-section/1";
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** The visit has one ADL record, so the kind names it; the visit itself is already on every audit row the ref rides on. */
const RECORDED_ADL_REF: DraftSourceRef = { kind: "recorded_adl", id: "recorded-adl" };

const emptySection = (sectionId: string): EmptyDraftSection => ({
  sectionId,
  state: "empty",
  reason: "nothing_to_draft_from",
});

/** Fail closed: a section is Part 2 unless EVERY source is explicitly (`=== false`) not SUD-related. */
const isPart2Derived = (groups: readonly SourceGroup[]): boolean =>
  !groups.every((g) => g.sudRelated === false);

/** What a drafted section says besides the sentences built from its sources: text that leads it, and the clinician's own words after. */
interface SectionWords {
  /** Text taken from a record the draft does not source sentences from (the visit's recorded ADLs), with the ref that names that record. */
  readonly lead: { readonly text: string; readonly ref: DraftSourceRef };
  readonly own: string;
}

function draftedSection(
  sectionId: string,
  groups: readonly SourceGroup[],
  words: SectionWords,
  deps: DraftDeps,
): DraftedSection {
  const drafted = joinSentences(groups.flatMap((g) => g.sentences));
  const text = normalizeText(
    [words.lead.text, drafted, words.own].filter((part) => part.length > 0).join(" "),
  );
  // The lead record leads the text, so its ref leads the refs (and the origins the clinician reads) when it said anything.
  const sourceRefs = [
    ...(words.lead.text.length > 0 ? [words.lead.ref] : []),
    ...groups.map((g) => g.ref),
  ];
  const part2Derived = isPart2Derived(groups);
  const contentHash = deps.sha256Hex(
    canonicalJson({ format: CONTENT_FORMAT, part2Derived, sectionId, sourceRefs, text }),
  );
  if (!SHA256_HEX.test(contentHash)) {
    throw new DraftInputError("deps.sha256Hex must return 64 lowercase hexadecimal characters");
  }
  return {
    sectionId,
    state: "drafted",
    text,
    sourceRefs,
    part2Derived,
    contentHash,
    corpusVersion: VOCAB_VERSION,
  };
}

/**
 * Compile the draft for one visit.
 *
 * Throws {@link HearthnoteAssemblyError} (same codes as `assemble`) when the selection was authored against
 * another corpus or names another template than `inputs`, or when the pair has no template; and
 * {@link DraftInputError} for a malformed field. The clinician's selections are rendered into a section
 * that has a source and are NEVER a source themselves: a section with only selections stays empty (VN-D9),
 * and selections do not affect `part2Derived` (a clinician's own text is not classified).
 */
export function compileDraft(inputs: DraftInputs, deps: DraftDeps): Draft {
  const asOfMs = instantMs(inputs.asOf, "asOf");
  const template = resolveSelectionTemplate(inputs.selection);
  const claimed = templateKey(inputs.encounterType, inputs.discipline);
  if (template.key !== claimed) {
    throw new HearthnoteAssemblyError(
      "TEMPLATE_KEY_MISMATCH",
      `selection is for '${template.key}' but the draft is for '${claimed}'`,
    );
  }
  // The corpus decides which sections of this template draft (scope.ts); a template with none builds no source group at all.
  const drafted = draftedSectionIds(template.encounterType, template.discipline);
  const groups: ReadonlyMap<string, readonly SourceGroup[]> =
    drafted.size === 0 ? new Map() : collectSourceGroups(inputs, asOfMs);
  const selections = new Map(inputs.selection.sections.map((s) => [s.sectionId, s]));
  const sections = template.sections.map((section): DraftSection => {
    const sourced = drafted.has(section.id) ? groups.get(section.id) : undefined;
    if (sourced === undefined) return emptySection(section.id);
    const own = selections.get(section.id);
    // The vitals source has no weight, height or BMI, and a confirmed section replaces the whole section: state them here, before the
    // clinician's own words, so a body measurement recorded on the visit is in the note whenever the vitals section is drafted.
    const measures =
      section.vitalsSummary === true
        ? describeRecordedBodyMeasures(inputs.context.recordedVitals)
        : "";
    // Likewise the recorded ADLs of a section that states them (the aide's `adl`): the confirmed text replaces the section, so a recorded
    // ADL the draft left out would vanish from the note. It LEADS the section, as it does in the assembled note.
    const recordedAdl =
      section.adlSummary === true ? describeRecordedAdl(inputs.context.recordedAdl) : "";
    const ownText = [measures, own === undefined ? "" : renderSection(own, inputs.context)]
      .filter((part) => part.length > 0)
      .join(" ");
    return draftedSection(
      section.id,
      sourced,
      { lead: { text: recordedAdl, ref: RECORDED_ADL_REF }, own: ownText },
      deps,
    );
  });
  return { templateKey: template.key, asOf: inputs.asOf, sections };
}
