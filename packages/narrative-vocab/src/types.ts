// packages/narrative-vocab/src/types.ts — M8-T05 (spec §2.6, architecture §10.5.2).
//
// The bounded clinical vocabulary surface. `@chartwarden/narrative-vocab` is a LEAF package — owned by no
// single module, consumed by M8 (encounters) and M14 (IDG aggregator). Each entry is a curated phrase
// the HearthNote Layer-1 assembly engine resolves into a byte-identical narrative; the package carries
// the data and the lookup shape, never the assembly logic (that is `@chartwarden/hearthnote`) and never an
// edit surface (vocabulary content ships through this package's own semver releases — spec "out of
// scope: the narrative vocabulary itself"). The only cross-package dependency is the leaf `@chartwarden/types`
// encounter-type / discipline axes, so a vocabulary entry's tags stay 1:1 with the encounter model.
import type { EncounterDiscipline, EncounterType } from "@chartwarden/types";

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
  | "attestation" // boilerplate regulatory attestation language
  // ── visit-note draft categories (S1 PR B, ADR-0114). DRAFT wording until CORPUS_CLINICAL_REVIEW is approved.
  | "chief_concern" // reason-for-visit phrase (RN routine visit `chief_concern` menu)
  | "vitals_review" // vital-sign phrase, interpolated from the visit's captured vitals
  | "plan" // plan / next-visit phrase (RN routine visit `plan` menu)
  | "scale_reading" // scale reading (PPS, ESAS-r) with its change since the previous reading; draft-only
  | "medication_change" // medication or order change since the last visit; draft-only
  // ── recertification and face-to-face draft categories (S2, VN-D31 to VN-D34). DRAFT wording until its release is reviewed.
  | "decline_evidence" // PPS against the benefit period's first reading, weight change, the face-to-face's facts; draft-only
  | "benefit_period" // the benefit period, the level of care on the visit date, the signed certification; draft-only
  | "visit_reason"; // why the visit happened — one choice per note (the "Reason for Visit" select)

/**
 * What a `${slot}` may hold. A slot with no spec is free text (non-blank at finalize, ≤ 200 characters).
 *
 * Specs constrain VALUES, never phrase bytes: a shipped phrase is D11-pinned, so a note signed years ago
 * must re-read identically. Tightening what a clinician may type is therefore safe on a live corpus;
 * rewording the sentence is not.
 */
export type SlotSpec =
  | {
      readonly kind: "integer" | "number";
      /** Inclusive bounds. */
      readonly min: number;
      readonly max: number;
      /** Shown beside the input; never interpolated (the phrase already carries its own unit). */
      readonly unit?: string;
      readonly label?: string;
    }
  | {
      readonly kind: "choice";
      /** Interpolated verbatim, so each option must read correctly inside the phrase. */
      readonly options: readonly string[];
      readonly label?: string;
    };

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
  /** Constraints for this phrase's `${slot}`s; a slot absent here is free text. */
  readonly slotSpecs?: Readonly<Record<string, SlotSpec>>;
  /**
   * Entries sharing a group contradict each other ("pain controlled" vs "pain limiting function"): a note
   * may carry at most one distinct code per group, across every section.
   */
  readonly exclusiveGroup?: string;
}
