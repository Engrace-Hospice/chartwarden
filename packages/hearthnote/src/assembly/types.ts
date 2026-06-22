// packages/hearthnote/src/assembly/types.ts — M8-T05 (spec §2.6, architecture §10.5.2).
//
// The Layer-1 assembly contract. A `SelectionState` is the clinician's structured choices (the versioned
// JSON tree persisted as `hearthnote_selection`); `AssemblyContext` is the resolved patient/visit context
// (name, date, location, numeric-direct vitals) interpolated into phrase templates. `assembleLayer1`
// (see ./assemble) is a pure function of (template, selection, context) → byte-identical `narrative`.
import type { EncounterDiscipline, EncounterType } from "@wardenx/types";

/** A scalar interpolated into a `${slot}` — strings stay verbatim, numbers are stringified once. */
export type SlotValue = string | number;

/** One selected vocabulary entry within a section, with its resolved `${slot}` params. */
export interface EntrySelection {
  /** The `VocabEntry.code` chosen from the section's menu. */
  readonly code: string;
  /** Values for the entry's phrase-template `${slot}`s (numeric-direct values: vitals, scores). */
  readonly params?: Readonly<Record<string, SlotValue>>;
}

/** A section's selections plus any verbatim clinician free-text (preserved exactly — never grammared). */
export interface SectionSelection {
  /** Matches a `TemplateSection.id`. */
  readonly sectionId: string;
  /** Ordered entry selections (assembly preserves this order). */
  readonly entries: readonly EntrySelection[];
  /** Verbatim clinician prose appended after the section's assembled sentences (decrypted in-memory). */
  readonly freeText?: string;
}

/** The full versioned selection tree for one encounter (or addendum). */
export interface SelectionState {
  /** `${encounterType}:${discipline}` — must match the resolved template's key. */
  readonly templateKey: string;
  /** The `VOCAB_VERSION` the selections were authored against; pinned at first finalize (D11). */
  readonly vocabVersion: string;
  readonly encounterType: EncounterType;
  readonly discipline: EncounterDiscipline;
  /** Sections in any order; assembly renders them in TEMPLATE order, not selection order. */
  readonly sections: readonly SectionSelection[];
}

/** The resolved patient/visit context interpolated into phrases (the `${slot}` value source of record). */
export interface AssemblyContext {
  /** How the patient is referred to in the narrative (Layer-1 uses the real name; Layer-2 minimizes). */
  readonly patient: string;
  /** Org-local service date string (already formatted by the caller; assembly never computes time). */
  readonly serviceDate: string;
  readonly location?: string;
  /** Numeric-direct vitals/scores exposed as `${slot}`s; never paraphrased by Layer 2 (D7 hard-block). */
  readonly vitals?: Readonly<Record<string, SlotValue>>;
}

/** The deterministic Layer-1 output. */
export interface AssemblyResult {
  /** The byte-identical assembled narrative (same inputs → same bytes). */
  readonly narrative: string;
  /** Section ids that produced content, in render order (omits empty sections). */
  readonly sectionsAssembled: readonly string[];
  /** The vocab version the narrative was assembled against (echoed from the selection). */
  readonly vocabVersion: string;
}
