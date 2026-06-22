// apps/backend/src/modules/12-dosespot — M12 (DoseSpot Integration) backend module surface.
//
// M12-T07 lands the two §2.10 D17 owned seams (MedicationOrderProvider — the medication-order read path
// M13/M14/M19/M28/M30/M31/M33 consume — + RefillInboxProvider — the refill-inbox read path the prescriber UI
// and M19/M33 consume) registered into the M1 registry via `registerDoseSpotSeams` (driven from the
// composition root's wireModuleSeams()).
export {
  type ComfortKitTimeline,
  type CostBasisRow,
  type DoseSpotSeamDeps,
  type DoseSpotSeamSeed,
  type DoseSpotSeamStore,
  createInMemoryDoseSpotSeamStore,
  createMedicationOrderProvider,
  createRefillInboxProvider,
  getMedicationOrderProvider,
  getRefillInboxProvider,
  registerDoseSpotSeams,
} from "./seams/index";
