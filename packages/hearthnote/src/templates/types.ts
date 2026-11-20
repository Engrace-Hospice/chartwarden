import type { VocabCategory } from "@chartwarden/narrative-vocab";
// packages/hearthnote/src/templates/types.ts — M8-T05 (spec §2.6, architecture §10.5.2).
//
// The template-engine shape. A HearthNote template is one (encounter_type × discipline) document
// skeleton: an ordered list of sections, each flagged required or optional and tagged with the vocab
// categories it draws from. Templates declare WHAT a note must contain; the Layer-3 compliance gate
// (M8-T04/T09) reads `required` to block signing, and the assembly engine reads the section order to
// produce byte-identical output. Templates are the regulatory floor — a tenant may add sections but
// never remove a `required` one (architecture §10.5.2); Phase 1 ships the platform defaults only.
import type { EncounterDiscipline, EncounterType } from "@chartwarden/types";

/** One ordered section of a template. */
export interface TemplateSection {
  /** Stable section id (selection state keys on this). */
  readonly id: string;
  /** Human heading rendered above the section's assembled sentences. */
  readonly heading: string;
  /**
   * A `required` section must be POPULATED before the Layer-3 gate passes (§2.6 check 1). Populated means a selection or the
   * clinician's own text, or, for a section that states a recorded finding (`adlSummary`, `nutritionSummary`), a saved record
   * with at least one ADL level / nutrition value. The Module 8 gate (`runEncounterComplianceGate`) is the one place that decides it.
   */
  readonly required: boolean;
  /**
   * The vocab categories whose statements this section offers. REQUIRED, and `[]` means "prose only": a
   * section that left it undeclared used to offer the whole catalog (the Reason for Visit section listed
   * every cardiovascular finding), so the declaration cannot be omitted. Scoping the selection menu is
   * all this does — the server still stores whatever statement it is given.
   */
  readonly allowedCategories: readonly VocabCategory[];
  /**
   * When true the section opens with the visit's recorded vitals, rendered from the stored values (never
   * typed or ticked), ahead of any statements and the clinician's own words.
   */
  readonly vitalsSummary?: boolean;
  /**
   * When true, a section that carries the follow-up-after-a-fall reason also states the date of the fall the
   * clinician linked, from the stored link (never typed), right after the statements.
   */
  readonly fallSummary?: boolean;
  /**
   * When true the section opens with the functional status recorded on the visit (assistance levels, continence,
   * devices), rendered from the stored values (never typed or ticked). A saved record with at least one ADL level populates the
   * section for the Layer-3 gate (check 1), exactly as a selection would.
   */
  readonly adlSummary?: boolean;
  /** When true the section opens with the nutrition and hydration recorded on the visit, from the stored values. */
  readonly nutritionSummary?: boolean;
  /** When true the section opens with one sentence per wound recorded on the visit, from the stored values. */
  readonly woundSummary?: boolean;
}

/** A fully-resolved template for one legal (encounterType × discipline) pair. */
export interface HearthnoteTemplate {
  /** `${encounterType}:${discipline}` — the registry key and the selection-state `templateKey`. */
  readonly key: string;
  readonly encounterType: EncounterType;
  readonly discipline: EncounterDiscipline;
  readonly sections: readonly TemplateSection[];
}

/** The registry key for a pair (the single place the `:`-joined convention lives). */
export function templateKey(encounterType: EncounterType, discipline: EncounterDiscipline): string {
  return `${encounterType}:${discipline}`;
}
