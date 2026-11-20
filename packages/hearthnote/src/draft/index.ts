// packages/hearthnote/src/draft/index.ts — S1 PR B. Visit-note draft compiler barrel.
export type {
  AdvanceDirectiveAcknowledgmentInput,
  BenefitPeriodDraftInput,
  CarePlanDraftInput,
  CarePlanGoalInput,
  CarePlanInterventionInput,
  CaregiverInput,
  CaregiverRelationship,
  CertificationDraftInput,
  Draft,
  DraftDeps,
  DraftInputs,
  DraftSection,
  DraftSourceBase,
  DraftSourceKind,
  DraftSourceRef,
  DraftedSection,
  EmptyDraftSection,
  FaceToFaceDraftInput,
  MedicationChangeInput,
  MedicationChangeKind,
  MedicationOrderInput,
  PreviousScaleReading,
  ScaleReadingInput,
  VitalsDraftInput,
  WeightBaselineInput,
  WeightDraftInput,
} from "./types";
export { type CanonicalValue, canonicalJson, normalizeText } from "./canonical";
export { compileDraft } from "./compile";
export {
  draftedSectionIds,
  emptyDraft,
  readsBenefitPeriod,
  templateHasDraftedSection,
} from "./scope";
export { DraftInputError, isWeightUnit } from "./validate";
