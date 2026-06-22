// apps/backend/src/modules/13-emar — M13 (eMAR & Med Administration) backend module surface.
//
// M13-T07 lands the two §2.12 D16 owned seams (MedicationAdministrationProvider — the administration read path
// M14/M28/M30/M31/M33/M37 consume — + ReconciliationProvider — the reconciliation-worksheet read path M14/M30
// consume) registered into the M1 registry via `registerEmarSeams` (driven from the composition root's
// wireModuleSeams()).
export {
  type ComfortKitAdministrationTimeline,
  type DoseScheduleRow,
  type DoseScheduleSeedRow,
  type EmarSeamDeps,
  type EmarSeamSeed,
  type EmarSeamStore,
  type IvContinuousSessionRow,
  type PrnEffectivenessRow,
  type PrnEffectivenessSeedRow,
  type ReconciliationTimelinessAnchor,
  createInMemoryEmarSeamStore,
  createMedicationAdministrationProvider,
  createReconciliationProvider,
  getMedicationAdministrationProvider,
  getReconciliationProvider,
  registerEmarSeams,
} from "./seams/index";
