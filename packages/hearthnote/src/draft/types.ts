// packages/hearthnote/src/draft/types.ts — the visit-note draft contract (S1 PR B, ADR-0114, VN-D4..VN-D12).
//
// `compileDraft` is PURE: no I/O, no clock, no randomness, no Node-only API (the hash function is
// injected), so the package can later be vendored into the React Native app (VN-D22). Inputs are
// already-read, already-redacted-for-this-author records; the backend does the as-of reads (VN-D11).
import type { EncounterDiscipline, EncounterType, ScaleType } from "@chartwarden/types";
import type { AssemblyContext, SelectionState } from "../assembly/types";

/** What a drafted sentence was built from. Source ids go to the audit trail only (VN-D7). */
export type DraftSourceKind =
  | "care_plan_goal"
  | "care_plan_intervention"
  | "scale_reading"
  | "vitals"
  | "medication_change"
  // S2 (recertification and face-to-face visits, design §3.3):
  | "weight_reading"
  | "benefit_period"
  | "face_to_face"
  | "certification";

// A `type`, not an `interface`: the canonical serializer takes plain data, and only an alias is
// assignable to its index-signature shape.
export type DraftSourceRef = {
  readonly kind: DraftSourceKind;
  readonly id: string;
};

/**
 * Fields every source carries. `sudRelated` is read FAIL CLOSED: only the literal `false` proves a source
 * is not SUD-related; `true`, a missing flag, `null` or any other value makes the section Part 2.
 */
export interface DraftSourceBase {
  readonly id: string;
  readonly sudRelated?: boolean | null;
}

export interface CarePlanGoalInput extends DraftSourceBase {
  readonly goalText: string;
  /** The goal's recorded progress, or `null` when none; the draft never invents one. */
  readonly progressStatement: string | null;
}

export interface CarePlanInterventionInput extends DraftSourceBase {
  readonly interventionText: string;
}

/** The care-plan goals and interventions linked to this visit, in the plan version in effect at `asOf`. */
export interface CarePlanDraftInput {
  readonly goals: readonly CarePlanGoalInput[];
  readonly interventions: readonly CarePlanInterventionInput[];
}

/** The reading before this one, as structured data: its value and its org-local date (YYYY-MM-DD). */
export interface PreviousScaleReading {
  readonly value: number;
  readonly recordedOn: string;
}

export interface ScaleReadingInput extends DraftSourceBase {
  /** Only `pps` and `esas_r` have phrases in v1; a reading of any other scale is not drafted. */
  readonly scaleType: ScaleType;
  /** Required for `esas_r` (the symptom the value is for, e.g. "pain"); unused for `pps`. */
  readonly label?: string;
  readonly value: number;
  /** ISO-8601 instant with a zone; a reading after `asOf` is left out. */
  readonly recordedAt: string;
  readonly previous?: PreviousScaleReading | null;
  /**
   * S2, `pps` only: the first reading of the benefit period before this one (its value and org-local date), or `null` when this
   * reading is the first. The recertification and face-to-face `prognosis` sections set it beside this reading; the recertification
   * `pps` section compares with it when there is no `previous`. Unused by the routine visit.
   */
  readonly baseline?: PreviousScaleReading | null;
}

/** The first weight of the benefit period: its value (a decimal) and org-local date, in the SAME unit as the reading it sits on. */
export interface WeightBaselineInput {
  readonly value: number | string;
  readonly recordedOn: string;
}

/** The patient's latest weight at or before the visit time (S2). The caller reads it across the benefit period, not only this encounter. */
export interface WeightDraftInput extends DraftSourceBase {
  /** ISO-8601 instant with a zone; a weight after `asOf` is left out. */
  readonly recordedAt: string;
  /** The org-local date (YYYY-MM-DD) the sentence shows. */
  readonly recordedOn: string;
  /** A decimal as a number or a numeric string; greater than zero. */
  readonly value: number | string;
  readonly unit: "kg" | "lb";
  /** The benefit period's first weight in the same unit, or `null` when this is the only one (or the units differ). */
  readonly baseline?: WeightBaselineInput | null;
}

/** The attested face-to-face encounter as module 6 reports it for the benefit period: facts only, never its narrative (VN-D32). */
export interface FaceToFaceDraftInput extends DraftSourceBase {
  readonly performerRole: "hospice_md" | "hospice_np";
  /** YYYY-MM-DD. */
  readonly performedOn: string;
  /** YYYY-MM-DD; a face-to-face attested after the service date is not drafted (VN-D11). */
  readonly attestedOn: string;
}

/** The signed certification of terminal illness for the benefit period; one signed after the service date is not drafted. */
export interface CertificationDraftInput extends DraftSourceBase {
  /** YYYY-MM-DD. */
  readonly signedOn: string;
}

/** The benefit period in effect on the service date (module 6, as of that date). */
export interface BenefitPeriodDraftInput extends DraftSourceBase {
  /** 1-based number of the benefit period within the election. */
  readonly sequence: number;
  readonly periodKind: "ninety_day" | "sixty_day";
  /** YYYY-MM-DD; the period must contain the service date. */
  readonly startDate: string;
  readonly endDate: string;
  /** The level of care on the service date, or `null` when it cannot be determined for that date (its sentence is then left out). */
  readonly levelOfCare:
    | "routine_home_care"
    | "continuous_home_care"
    | "inpatient_respite_care"
    | "general_inpatient_care"
    | null;
  readonly faceToFace: FaceToFaceDraftInput | null;
  readonly certification: CertificationDraftInput | null;
}

/** One captured vitals set. A field that is absent is not drafted; a blood pressure needs both numbers. */
export interface VitalsDraftInput extends DraftSourceBase {
  readonly recordedAt: string;
  readonly bpSystolic?: number;
  readonly bpDiastolic?: number;
  readonly heartRate?: number;
  readonly respiratoryRate?: number;
  /** A decimal as a number or a numeric string ("98.6"); needs `temperatureUnit`. */
  readonly temperature?: number | string;
  readonly temperatureUnit?: "f" | "c";
  readonly spo2?: number;
  /** 0-10 numeric rating. A pain reading on any other scale is a scale reading, not a vital. */
  readonly painScore?: number;
}

export type MedicationChangeKind = "started" | "changed" | "discontinued";

export interface MedicationChangeInput extends DraftSourceBase {
  readonly drugName: string;
  readonly change: MedicationChangeKind;
  /** ISO-8601 instant with a zone; a change after `asOf` is left out. */
  readonly changedAt: string;
  /** The org-local date (YYYY-MM-DD) the sentence shows. */
  readonly changedOn: string;
}

export interface DraftInputs {
  readonly encounterType: EncounterType;
  readonly discipline: EncounterDiscipline;
  /** The visit time as an ISO-8601 instant with a zone (VN-D11). */
  readonly asOf: string;
  /** The clinician's own selections. They are rendered into a section that has a source; never a source. */
  readonly selection: SelectionState;
  /** Patient and service-date slots for rendering the selections. */
  readonly context: AssemblyContext;
  /** `null` when the patient has no care plan. */
  readonly carePlan: CarePlanDraftInput | null;
  readonly scaleReadings: readonly ScaleReadingInput[];
  readonly vitals: VitalsDraftInput | null;
  readonly medicationChanges: readonly MedicationChangeInput[];
  /** S2: the latest weight across the benefit period; absent or `null` for none. Read by the recertification and face-to-face templates only. */
  readonly weight?: WeightDraftInput | null;
  /** S2: the benefit period on the service date; absent or `null` for none. Read by the recertification template only. */
  readonly benefitPeriod?: BenefitPeriodDraftInput | null;
}

export interface DraftDeps {
  /**
   * SHA-256 of the UTF-8 bytes of `canonical`, as 64 lowercase hex characters. The backend passes Node
   * crypto; the package holds no crypto of its own.
   */
  readonly sha256Hex: (canonical: string) => string;
}

export interface DraftedSection {
  readonly sectionId: string;
  readonly state: "drafted";
  /** Source-derived sentences, then the clinician's own rendered selections for the section. */
  readonly text: string;
  readonly sourceRefs: readonly DraftSourceRef[];
  /** True unless every source behind the section is explicitly not SUD-related (42 CFR Part 2). */
  readonly part2Derived: boolean;
  /** SHA-256 of the canonical JSON of the section (see `canonical.ts`); VN-D12 binds a confirmation to it. */
  readonly contentHash: string;
  readonly corpusVersion: string;
}

/** A section with nothing to draft from (VN-D9): no text, never a default phrase. */
export interface EmptyDraftSection {
  readonly sectionId: string;
  readonly state: "empty";
  readonly reason: "nothing_to_draft_from";
}

export type DraftSection = DraftedSection | EmptyDraftSection;

export interface Draft {
  readonly templateKey: string;
  readonly asOf: string;
  /** Every section of the template, in template order. */
  readonly sections: readonly DraftSection[];
}
