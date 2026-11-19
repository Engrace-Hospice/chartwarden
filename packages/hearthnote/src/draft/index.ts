// packages/hearthnote/src/draft/index.ts — S1 PR B. Visit-note draft compiler barrel.
export type {
  CarePlanDraftInput,
  CarePlanGoalInput,
  CarePlanInterventionInput,
  Draft,
  DraftDeps,
  DraftInputs,
  DraftSection,
  DraftSourceBase,
  DraftSourceKind,
  DraftSourceRef,
  DraftedSection,
  EmptyDraftSection,
  MedicationChangeInput,
  MedicationChangeKind,
  PreviousScaleReading,
  ScaleReadingInput,
  VitalsDraftInput,
} from "./types";
export { type CanonicalValue, canonicalJson, normalizeText } from "./canonical";
export { compileDraft } from "./compile";
export { DraftInputError } from "./validate";
