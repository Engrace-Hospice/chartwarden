// packages/narrative-vocab/src/types.ts — M8-T05 (spec §2.6, architecture §10.5.2).
//
// The bounded clinical vocabulary surface. `@wardenx/narrative-vocab` is a LEAF package — owned by no
// single module, consumed by M8 (encounters) and M14 (IDG aggregator). Each entry is a curated phrase
// the HearthNote Layer-1 assembly engine resolves into a byte-identical narrative; the package carries
// the data and the lookup shape, never the assembly logic (that is `@wardenx/hearthnote`) and never an
// edit surface (vocabulary content ships through this package's own semver releases — spec "out of
// scope: the narrative vocabulary itself"). The only cross-package dependency is the leaf `@wardenx/types`
// encounter-type / discipline axes, so a vocabulary entry's tags stay 1:1 with the encounter model.
import type { EncounterDiscipline, EncounterType } from "@wardenx/types";

/** The §10.5.2 per-body-system observation axis (one of nine clinical systems). */
export type VocabBodySystem =
  | "cardiovascular"
  | "respiratory"
  | "neurological"
  | "gastrointestinal"
  | "genitourinary"
  | "integumentary"
  | "musculoskeletal"
  | "psychosocial"
  | "spiritual";

/** What kind of clinical content a vocabulary entry contributes (drives section eligibility). */
export type VocabCategory =
  | "observation" // per-body-system finding
  | "symptom_impact" // HOPE J2051-aligned symptom-impact phrase
  | "care_plan_element" // care-plan-aligned intervention/goal phrase
  | "psychosocial" // MSW psychosocial finding
  | "spiritual" // chaplain spiritual finding
  | "adl" // CHHA activities-of-daily-living documentation
  | "attestation"; // boilerplate regulatory attestation language

/**
 * One curated vocabulary entry. `phrase` is a narrative phrase template with `${slot}` placeholders the
 * assembly engine resolves from the selection params + the patient context (e.g. `${patient}`,
 * `${pps_score}`); numeric-direct slots (vitals, scores) are interpolated verbatim and are never
 * paraphrased by Layer 2 (D7 hard-block). `disciplines`/`encounterTypes` are the scoping tags the
 * selection UI filters on and the template engine reads.
 */
export interface VocabEntry {
  /** Stable curated code (SNOMED-style where a concept exists, else a `nv.*` curated id). */
  readonly code: string;
  /** Plain-language menu label the clinician picks. */
  readonly label: string;
  /** Narrative phrase template with `${slot}` placeholders (resolved at assembly time). */
  readonly phrase: string;
  readonly category: VocabCategory;
  /** Present only for `observation` entries (the nine-system axis). */
  readonly bodySystem?: VocabBodySystem;
  /** Disciplines whose menus surface this entry. */
  readonly disciplines: readonly EncounterDiscipline[];
  /** Encounter types whose templates surface this entry. */
  readonly encounterTypes: readonly EncounterType[];
}
