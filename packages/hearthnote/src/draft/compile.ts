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
import { templateKey } from "../templates/types";
import { canonicalJson, normalizeText } from "./canonical";
import { draftedSectionIds } from "./scope";
import { type SourceGroup, collectSourceGroups } from "./sources";
import type {
  Draft,
  DraftDeps,
  DraftInputs,
  DraftSection,
  DraftedSection,
  EmptyDraftSection,
} from "./types";
import { DraftInputError, instantMs } from "./validate";

/** Written into every hashed payload; a change to the canonical rule needs a new value (see canonical.ts). */
const CONTENT_FORMAT = "hearthnote-draft-section/1";
const SHA256_HEX = /^[0-9a-f]{64}$/;

const emptySection = (sectionId: string): EmptyDraftSection => ({
  sectionId,
  state: "empty",
  reason: "nothing_to_draft_from",
});

/** Fail closed: a section is Part 2 unless EVERY source is explicitly (`=== false`) not SUD-related. */
const isPart2Derived = (groups: readonly SourceGroup[]): boolean =>
  !groups.every((g) => g.sudRelated === false);

function draftedSection(
  sectionId: string,
  groups: readonly SourceGroup[],
  ownText: string,
  deps: DraftDeps,
): DraftedSection {
  const drafted = joinSentences(groups.flatMap((g) => g.sentences));
  const text = normalizeText(ownText.length === 0 ? drafted : `${drafted} ${ownText}`);
  const sourceRefs = groups.map((g) => g.ref);
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
    const ownText = own === undefined ? "" : renderSection(own, inputs.context);
    return draftedSection(section.id, sourced, ownText, deps);
  });
  return { templateKey: template.key, asOf: inputs.asOf, sections };
}
