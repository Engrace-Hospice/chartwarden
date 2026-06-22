// packages/hearthnote/src/assembly/assemble.ts — M8-T05 (spec §2.6, architecture §10.5.2).
//
// The Layer-1 deterministic core. `assembleLayer1` takes a resolved template + the clinician's selection
// state + the patient/visit context and returns a byte-identical narrative: sections rendered in TEMPLATE
// order, each entry's phrase resolved from `@wardenx/narrative-vocab` and interpolated against the merged
// context/params map, free-text appended verbatim. Pure and total — same inputs always yield the same
// bytes (architecture §10.5.2 "Properties"). The convenience `assemble` resolves the template and enforces
// the D11 vocab-version pin + the legal-pair guard, raising typed errors the M8 service maps to HTTP.
import { VOCAB_VERSION, getVocabEntry } from "@wardenx/narrative-vocab";
import type { HearthnoteTemplate } from "../templates/types";
import { resolveTemplate } from "../templates/registry";
import { templateKey } from "../templates/types";
import { finishSentence, interpolate, joinSentences } from "./grammar";
import type {
  AssemblyContext,
  AssemblyResult,
  SectionSelection,
  SelectionState,
  SlotValue,
} from "./types";

/** Machine-readable Layer-1 assembly failures (mapped to HTTP by the M8 service in T09). */
export type AssemblyErrorCode =
  | "TEMPLATE_NOT_FOUND" // illegal (encounterType × discipline) pair — 422 INVALID_ENCOUNTER_DISCIPLINE_PAIR
  | "TEMPLATE_KEY_MISMATCH" // selection.templateKey ≠ the pair it claims
  | "VOCAB_VERSION_MISMATCH" // selection authored against a different corpus — 409 VOCAB_VERSION_MISMATCH (D11)
  | "UNKNOWN_VOCAB_CODE"; // a selected code is not in the shipped corpus

export class HearthnoteAssemblyError extends Error {
  constructor(
    readonly code: AssemblyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HearthnoteAssemblyError";
  }
}

/** Build the merged `${slot}` value map for one entry: context base, then entry-specific params win. */
function slotValues(
  context: AssemblyContext,
  params: Readonly<Record<string, SlotValue>> | undefined,
): Record<string, SlotValue> {
  return {
    patient: context.patient,
    serviceDate: context.serviceDate,
    ...(context.location !== undefined ? { location: context.location } : {}),
    ...(context.vitals ?? {}),
    ...(params ?? {}),
  };
}

/** Render one section's body (assembled sentences + verbatim free-text), or "" when it has no content. */
function renderSection(section: SectionSelection, context: AssemblyContext): string {
  const sentences: string[] = [];
  for (const entry of section.entries) {
    const vocab = getVocabEntry(entry.code);
    if (vocab === undefined) {
      throw new HearthnoteAssemblyError(
        "UNKNOWN_VOCAB_CODE",
        `selected vocabulary code '${entry.code}' is not in the corpus`,
      );
    }
    sentences.push(finishSentence(interpolate(vocab.phrase, slotValues(context, entry.params))));
  }
  const assembled = joinSentences(sentences);
  const free = section.freeText?.trim() ?? "";
  if (assembled.length === 0 && free.length === 0) return "";
  // Free-text is preserved VERBATIM (no grammar applied) — spec §2.6 / architecture §10.5.2.
  return free.length === 0 ? assembled : assembled.length === 0 ? free : `${assembled} ${free}`;
}

/**
 * Assemble the Layer-1 narrative for a resolved template. Sections render in TEMPLATE order (not selection
 * order); empty sections are omitted from the output (the Layer-3 gate, not assembly, enforces required
 * sections). Pure: same `(template, selection, context)` → same bytes.
 */
export function assembleLayer1(
  template: HearthnoteTemplate,
  selection: SelectionState,
  context: AssemblyContext,
): AssemblyResult {
  const byId = new Map(selection.sections.map((s) => [s.sectionId, s]));
  const blocks: string[] = [];
  const sectionsAssembled: string[] = [];
  for (const tmplSection of template.sections) {
    const picked = byId.get(tmplSection.id);
    if (picked === undefined) continue;
    const body = renderSection(picked, context);
    if (body.length === 0) continue;
    blocks.push(`${tmplSection.heading}\n${body}`);
    sectionsAssembled.push(tmplSection.id);
  }
  return {
    narrative: blocks.join("\n\n"),
    sectionsAssembled,
    vocabVersion: selection.vocabVersion,
  };
}

/**
 * Resolve the template for the selection's pair and assemble. Enforces the D11 vocab-version pin and the
 * legal-pair / key-integrity guards, raising {@link HearthnoteAssemblyError} the M8 service maps to HTTP.
 */
export function assemble(selection: SelectionState, context: AssemblyContext): AssemblyResult {
  if (selection.vocabVersion !== VOCAB_VERSION) {
    throw new HearthnoteAssemblyError(
      "VOCAB_VERSION_MISMATCH",
      `selection pinned to '${selection.vocabVersion}' but the active corpus is '${VOCAB_VERSION}'`,
    );
  }
  const expectedKey = templateKey(selection.encounterType, selection.discipline);
  if (selection.templateKey !== expectedKey) {
    throw new HearthnoteAssemblyError(
      "TEMPLATE_KEY_MISMATCH",
      `selection.templateKey '${selection.templateKey}' does not match '${expectedKey}'`,
    );
  }
  const template = resolveTemplate(selection.encounterType, selection.discipline);
  if (template === undefined) {
    throw new HearthnoteAssemblyError(
      "TEMPLATE_NOT_FOUND",
      `no template for the illegal pair '${expectedKey}'`,
    );
  }
  return assembleLayer1(template, selection, context);
}

/**
 * The required sections that have NO populated selection (the Layer-3 gate's check-1 remediation list).
 * A section counts as populated when it has ≥ 1 entry or non-empty free-text. Template-engine query, kept
 * here so the gate (M8-T04/T09) reads it rather than re-deriving "required".
 */
export function missingRequiredSections(
  template: HearthnoteTemplate,
  selection: SelectionState,
): readonly string[] {
  const populated = new Set(
    selection.sections
      .filter((s) => s.entries.length > 0 || (s.freeText?.trim().length ?? 0) > 0)
      .map((s) => s.sectionId),
  );
  return template.sections.filter((s) => s.required && !populated.has(s.id)).map((s) => s.id);
}
