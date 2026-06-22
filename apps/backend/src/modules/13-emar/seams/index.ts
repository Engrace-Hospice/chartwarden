// apps/backend/src/modules/13-emar/seams — M13's published §2.12 D16 owned seams (M13-T07). M13 publishes TWO
// leaf-typed READ surfaces forward consumers attach to instead of importing M13's schema (architecture §25.15
// blocks the schema import): `MedicationAdministrationProvider` — the administration read path M14 (IDG
// "administrations since last meeting"), M28 (FHIR `MedicationAdministration`), M30 (PRN-effectiveness /
// missed-dose / comfort-kit-timeliness measures), M31 (portal lay-language summary, SUD-redacted), M33
// (dashboards), M37 (IPU IV-pump overlay) consume — and `ReconciliationProvider` — the reconciliation-worksheet
// read path M14 (IDG packet) and M30 (reconciliation-timeliness measure) consume. `registerEmarSeams` registers
// both real impls over their boot deny-stubs (before validateSeams()), driven from the composition root's
// wireModuleSeams(). Both share ONE injected EmarSeamStore (in-memory slice here; Drizzle in prod, reads under
// the consumer's RLS) — mirrors the M9/M10/M11/M12 seams/index.ts precedents. Neither seam is a mutate path: M13
// owns the administration + reconciliation lifecycle internally.
import type { MedicationAdministrationProvider, ReconciliationProvider } from "@wardenx/types";
import { getSeam, registerSeam } from "../../../bootstrap/index";
import { createMedicationAdministrationProvider, createReconciliationProvider } from "./providers";
import { type EmarSeamStore, createInMemoryEmarSeamStore } from "./store";

export {
  type ComfortKitAdministrationTimeline,
  type DoseScheduleRow,
  type DoseScheduleSeedRow,
  type EmarSeamSeed,
  type EmarSeamStore,
  type IvContinuousSessionRow,
  type PrnEffectivenessRow,
  type PrnEffectivenessSeedRow,
  type ReconciliationTimelinessAnchor,
  createInMemoryEmarSeamStore,
} from "./store";
export {
  createMedicationAdministrationProvider,
  createReconciliationProvider,
} from "./providers";

/** Deps for M13's owned-seam registration (slice defaults to the in-memory store). */
export interface EmarSeamDeps {
  /** The §2.12 data port (Drizzle over M13's tables in prod; in-memory slice in tests). */
  store?: EmarSeamStore;
}

/**
 * Register M13's two §2.12 D16 owned seams into the M1 registry over their boot deny-stubs (M13-T07; before
 * validateSeams()). Both share one {@link EmarSeamStore} so a single Drizzle adapter backs the whole
 * administration + reconciliation read surface. Called by the composition root's wireModuleSeams().
 */
export function registerEmarSeams(deps: EmarSeamDeps = {}): void {
  const store = deps.store ?? createInMemoryEmarSeamStore().store;
  registerSeam("MedicationAdministrationProvider", createMedicationAdministrationProvider(store));
  registerSeam("ReconciliationProvider", createReconciliationProvider(store));
}

/** Typed resolver for M13's MedicationAdministrationProvider (M14/M28/M30/M31/M33/M37 consume the read seam). */
export function getMedicationAdministrationProvider(): MedicationAdministrationProvider {
  return getSeam("MedicationAdministrationProvider");
}

/** Typed resolver for M13's ReconciliationProvider (M14/M30 consume the read seam). */
export function getReconciliationProvider(): ReconciliationProvider {
  return getSeam("ReconciliationProvider");
}
